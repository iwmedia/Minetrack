const Database = require('./database')
const PingController = require('./ping')
const Server = require('./server')
const ServerRegistration = require('./servers')
const { TimeTracker } = require('./time')
const MessageOf = require('./message')

const logger = require('./logger')

const config = require('./config')
const minecraftVersions = require('./minecraftVersions')

class App {
  serverRegistrations = []

  constructor () {
    this.pingController = new PingController(this)
    this.server = new Server(this)
    this.timeTracker = new TimeTracker(this)
  }

  loadDatabase (callback) {
    this.database = new Database(this)

    // The servers collection is the single source of truth for tracked servers
    this.database.loadServers(serverDocuments => {
      if (serverDocuments.length === 0) {
        logger.log('warn', 'The "servers" collection is empty. Insert server documents ({ name, ip, type: "JAVA"|"BEDROCK" }) into MongoDB to begin tracking.')
      }

      serverDocuments.forEach((server, serverId) => {
        // Assign a generated color for each server if not defined in the document
        // These will be passed to the frontend for use in rendering
        if (!server.color) {
          let hash = 0
          for (let i = server.name.length - 1; i >= 0; i--) {
            hash = server.name.charCodeAt(i) + ((hash << 5) - hash)
          }

          const color = Math.floor(Math.abs((Math.sin(hash) * 10000) % 1 * 16777216)).toString(16)
          server.color = '#' + Array(6 - color.length + 1).join('0') + color
        }

        this.serverRegistrations.push(new ServerRegistration(this, serverId, server))
      })

      if (!config.logToDatabase) {
        logger.log('warn', 'Database logging is not enabled. You can enable it by setting "logToDatabase" to true in config.json.')

        callback()
        return
      }

      // Setup database instance
      this.database.ensureIndexes(() => {
        this.database.loadGraphPoints(config.graphDuration, () => {
          this.database.loadRecords(() => {
            if (config.retention && config.retention.enabled) {
              this.database.initMaintenance(callback)
            } else {
              callback()
            }
          })
        })
      })
    })
  }

  handleReady () {
    this.server.listen(config.site.ip, config.site.port)

    // Allow individual modules to manage their own task scheduling
    this.pingController.schedule()
  }

  handleClientConnection = (client) => {
    if (config.logToDatabase) {
      client.on('message', (message) => {
        // ws 8+ delivers messages as Buffer instances
        if (message.toString() === 'requestHistoryGraph') {
          // Send historical graphData built from all serverRegistrations
          const graphData = this.serverRegistrations.map(serverRegistration => serverRegistration.graphData)

          // Send graphData in object wrapper to avoid needing to explicity filter
          // any header data being appended by #MessageOf since the graph data is fed
          // directly into the graphing system
          client.send(MessageOf('historyGraph', {
            timestamps: this.timeTracker.getGraphPoints(),
            graphData
          }))
        }
      })
    }

    const initMessage = {
      config: (() => {
        // Remap minecraftVersion entries into name values
        const versions = minecraftVersions.get()
        const minecraftVersionNames = {}
        Object.keys(versions).forEach(function (key) {
          minecraftVersionNames[key] = versions[key].map(version => version.name)
        })

        // Send configuration data for rendering the page
        return {
          graphDurationLabel: config.graphDurationLabel || (Math.floor(config.graphDuration / (60 * 60 * 1000)) + 'h'),
          graphMaxLength: TimeTracker.getMaxGraphDataLength(),
          serverGraphMaxLength: TimeTracker.getMaxServerGraphDataLength(),
          servers: this.serverRegistrations.map(serverRegistration => serverRegistration.getPublicData()),
          minecraftVersions: minecraftVersionNames,
          isGraphVisible: config.logToDatabase
        }
      })(),
      timestampPoints: this.timeTracker.getServerGraphPoints(),
      servers: this.serverRegistrations.map(serverRegistration => serverRegistration.getPingHistory())
    }

    client.send(MessageOf('init', initMessage))
  }
}

module.exports = App

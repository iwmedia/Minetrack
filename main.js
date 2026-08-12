const App = require('./lib/app')

const logger = require('./lib/logger')
const minecraftVersions = require('./lib/minecraftVersions')

const config = require('./config')

const app = new App()

if (!config.serverGraphDuration) {
  logger.log('warn', '"serverGraphDuration" is not defined in config.json - defaulting to 3 minutes!')
  config.serverGraphDuration = 3 * 60 * 10000
}

// The ping scheduler cannot run without the protocol version list
minecraftVersions.init().then(() => {
  app.loadDatabase(() => {
    app.handleReady()
  })
}).catch(() => {
  logger.log('error', 'Minetrack cannot start without the Minecraft version list')
  process.exit(1)
})

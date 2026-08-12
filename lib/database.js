const { MongoClient } = require('mongodb')

const logger = require('./logger')

const config = require('./config')
const { TimeTracker } = require('./time')

// Rollups re-process a trailing window each run so hour boundaries and
// downtime gaps self-heal; $merge with whenMatched:replace keeps this idempotent
const ROLLUP_OVERLAP_MILLIS = 3 * 60 * 60 * 1000
const DAILY_ROLLUP_WINDOW_MILLIS = 2 * 24 * 60 * 60 * 1000

// Raw ping deletes run in bounded time windows to avoid a single unbounded
// deleteMany after long retention backlogs (oplog/storage pressure)
const DELETE_CHUNK_MILLIS = 6 * 60 * 60 * 1000
const DELETE_MAX_CHUNKS_PER_RUN = 24

const MILLIS_PER_DAY = 24 * 60 * 60 * 1000

class Database {
  constructor (app) {
    this._app = app

    const uri = process.env.MONGO_URI
    if (!uri) {
      logger.log('error', 'The MONGO_URI environment variable is required')
      throw new Error('Missing MONGO_URI environment variable')
    }

    this._client = new MongoClient(uri)

    // The name is the stable identity anchor; ip may change without losing history
    this._serverIdsByName = new Map()
    this._namesByServerIdHex = new Map()

    this._insertInFlight = false
    this._maintenanceRunning = false
    this._lastRollupTime = null
  }

  // Startup failures are fatal by design: without a database the state is undefined.
  // Runtime write failures (further below) only log and degrade, the live tracker
  // keeps running from memory.
  _exitOnStartupError (context, err) {
    logger.log('error', '%s: %s', context, err.message)
    process.exit(1)
  }

  getServerIdHex (name) {
    const serverId = this._serverIdsByName.get(name)
    return serverId ? serverId.toHexString() : null
  }

  // Connects and loads the server list - the single source of truth for which
  // servers are tracked. Documents: { name, ip, type: JAVA|BEDROCK, port?, color? }
  loadServers (callback) {
    this._connectAndLoadServers().then(serverDocuments => {
      callback(serverDocuments)
    }).catch(err => {
      this._exitOnStartupError('Cannot connect to MongoDB or load the server list', err)
    })
  }

  async _connectAndLoadServers () {
    await this._client.connect()

    // The driver reports "test" when the URI does not include a database name
    const uriDatabaseName = this._client.options.dbName
    const databaseName = (!uriDatabaseName || uriDatabaseName === 'test') ? 'minetrack' : uriDatabaseName

    this._db = this._client.db(databaseName)

    this._servers = this._db.collection('servers')
    this._pings = this._db.collection('pings')
    this._playerRecords = this._db.collection('playerRecords')
    this._pingsHourly = this._db.collection('pingsHourly')
    this._pingsDaily = this._db.collection('pingsDaily')

    // _id order equals insertion order, keeping display order stable across restarts
    const serverDocuments = await this._servers.find({}).sort({ _id: 1 }).toArray()

    for (const document of serverDocuments) {
      this._serverIdsByName.set(document.name, document._id)
      this._namesByServerIdHex.set(document._id.toHexString(), document.name)
    }

    return serverDocuments
  }

  ensureIndexes (callback) {
    this._prepareCollections().then(() => {
      callback()
    }).catch(err => {
      this._exitOnStartupError('Cannot prepare collections or indexes', err)
    })
  }

  async _prepareCollections () {
    await this._preparePingsCollection()

    await this._servers.createIndex({ name: 1 }, { unique: true })

    // Time-series collections manage their own bucket index on the timeField
    if (!config.timeSeries) {
      await this._pings.createIndex({ timestamp: 1 })
    }

    // The unique compound index doubles as the $merge key of the rollups
    await this._pingsHourly.createIndex({ serverId: 1, timestamp: 1 }, { unique: true })
    await this._pingsHourly.createIndex({ timestamp: 1 })
    await this._pingsDaily.createIndex({ serverId: 1, timestamp: 1 }, { unique: true })
    await this._pingsDaily.createIndex({ timestamp: 1 })
  }

  // Opt-in for MongoDB time-series storage of raw pings (config.timeSeries).
  // Requires a MongoDB version with mature time-series support (6.0+ recommended).
  // Since raw pings are short-lived and all long-term data lives in the rollup
  // collections, enabling this later is cheap: stop the app, rename or drop the
  // old "pings" collection, set the flag, start the app.
  async _preparePingsCollection () {
    if (!config.timeSeries) {
      return
    }

    const existing = await this._db.listCollections({ name: 'pings' }).toArray()

    if (existing.length === 0) {
      await this._db.createCollection('pings', {
        timeseries: {
          timeField: 'timestamp',
          metaField: 'serverId',
          granularity: 'seconds'
        },
        expireAfterSeconds: this._rawPingsDays() * 24 * 60 * 60
      })

      logger.info('Created "pings" as a time-series collection')
    } else if (existing[0].type !== 'timeseries') {
      logger.log('error', '"timeSeries" is enabled but the existing "pings" collection is a regular collection. Rename or drop it (raw pings are short-lived; long-term data lives in pingsHourly/pingsDaily), then restart.')
      throw new Error('Existing "pings" collection is not a time-series collection')
    }
  }

  loadGraphPoints (graphDuration, callback) {
    const endTime = TimeTracker.getEpochMillis()
    const startTime = endTime - graphDuration

    // Aggregate raw pings into minute buckets server-side; all servers share
    // one canonical timestamp axis. $first keeps the first ping per minute.
    this._pings.aggregate([
      { $match: { timestamp: { $gte: new Date(startTime), $lte: new Date(endTime) } } },
      { $sort: { timestamp: 1 } },
      {
        $group: {
          _id: {
            serverId: '$serverId',
            minute: { $dateTrunc: { date: '$timestamp', unit: 'minute' } }
          },
          onlinePlayers: { $first: '$onlinePlayers' }
        }
      },
      { $sort: { '_id.minute': 1 } }
    ]).toArray().then(rows => {
      // Build the canonical, shared timestamp axis from all seen minute buckets
      const bucketSet = new Set()
      const pointsByServerHex = new Map()

      for (const row of rows) {
        const bucket = row._id.minute.getTime()
        bucketSet.add(bucket)

        const serverIdHex = row._id.serverId.toHexString()
        let points = pointsByServerHex.get(serverIdHex)
        if (!points) {
          pointsByServerHex.set(serverIdHex, points = new Map())
        }
        points.set(bucket, row.onlinePlayers)
      }

      const timestamps = [...bucketSet].sort((a, b) => a - b)

      if (timestamps.length > 0) {
        for (const serverRegistration of this._app.serverRegistrations) {
          const serverId = this._serverIdsByName.get(serverRegistration.data.name)
          if (!serverId) {
            continue
          }

          const points = pointsByServerHex.get(serverId.toHexString())
          if (!points) {
            continue
          }

          // Align every server to the shared axis; minutes without data become null
          const playerCounts = timestamps.map(bucket => {
            const onlinePlayers = points.get(bucket)
            return onlinePlayers === undefined ? null : onlinePlayers
          })

          serverRegistration.loadGraphPoints(startTime, timestamps, playerCounts)
        }

        this._app.timeTracker.loadGraphPoints(startTime, timestamps)
      }

      callback()
    }).catch(err => {
      this._exitOnStartupError('Cannot load graph points', err)
    })
  }

  loadRecords (callback) {
    const serverIds = [...this._serverIdsByName.values()]

    this._playerRecords.find({ _id: { $in: serverIds } }).toArray().then(documents => {
      const recordsByServerIdHex = new Map()
      for (const document of documents) {
        recordsByServerIdHex.set(document._id.toHexString(), document)
      }

      for (const serverRegistration of this._app.serverRegistrations) {
        // Find graphPeaks
        // This pre-computes the values prior to clients connecting
        serverRegistration.findNewGraphPeak()

        const serverIdHex = this.getServerIdHex(serverRegistration.data.name)
        const document = serverIdHex ? recordsByServerIdHex.get(serverIdHex) : undefined

        if (document) {
          serverRegistration.recordData = {
            playerCount: document.playerCount,
            timestamp: TimeTracker.toSeconds(document.timestamp.getTime())
          }
        } else {
          // No record yet; the first successful ping upserts one atomically
          serverRegistration.recordData = {
            playerCount: null,
            timestamp: TimeTracker.toSeconds(null)
          }
        }
      }

      callback()
    }).catch(err => {
      this._exitOnStartupError('Cannot load player count records', err)
    })
  }

  // Inserts one document per server for a completed ping round in a single batch.
  // Skips the round (with a warning) while a previous batch is still unacknowledged,
  // so a slow database degrades to dropped samples instead of unbounded memory growth.
  insertPings (timestampMillis, entries) {
    if (this._insertInFlight) {
      logger.log('warn', 'Skipping ping database batch: previous batch still in flight. The database may be too slow for "rates.pingAll".')
      return
    }

    const timestamp = new Date(timestampMillis)
    const documents = []

    for (const entry of entries) {
      const serverId = this._serverIdsByName.get(entry.name)
      if (!serverId) {
        logger.log('warn', 'No server document for %s, skipping ping insert', entry.name)
        continue
      }

      const document = {
        timestamp,
        serverId,
        onlinePlayers: entry.onlinePlayers
      }

      if (Number.isFinite(entry.maxPlayers)) {
        document.maxPlayers = entry.maxPlayers
      }

      if (entry.error) {
        document.error = entry.error
      }

      documents.push(document)
    }

    if (documents.length === 0) {
      return
    }

    this._insertInFlight = true

    this._pings.insertMany(documents, { ordered: false }).catch(err => {
      logger.log('error', 'Cannot insert ping documents: %s', err.message)
    }).finally(() => {
      this._insertInFlight = false
    })
  }

  // Atomic, idempotent record update: the comparison happens server-side in an
  // update pipeline, so there is no read-modify-write race and no dependency on
  // an initial insert. The filter must remain exactly { _id } for upsert safety.
  updatePlayerCountRecord (name, playerCount, timestampMillis) {
    const serverId = this._serverIdsByName.get(name)
    if (!serverId) {
      logger.log('warn', 'No server document for %s, skipping record update', name)
      return
    }

    const isNewRecord = { $gt: [playerCount, { $ifNull: ['$playerCount', -1] }] }

    this._playerRecords.updateOne({ _id: serverId }, [{
      $set: {
        playerCount: { $cond: [isNewRecord, playerCount, '$playerCount'] },
        timestamp: { $cond: [isNewRecord, new Date(timestampMillis), '$timestamp'] }
      }
    }], { upsert: true }).catch(err => {
      logger.log('error', 'Cannot update player count record of %s: %s', name, err.message)
    })
  }

  // Sequential maintenance: rollups strictly before raw deletes, so raw data can
  // never be deleted before it has been aggregated. One interval, one chain.
  initMaintenance (callback) {
    const rawRetentionMillis = this._rawPingsDays() * MILLIS_PER_DAY
    if (rawRetentionMillis < config.graphDuration) {
      logger.log('warn', '"retention.rawPingsDays" keeps less raw data than "graphDuration" spans - the startup graph will be truncated')
    }

    this.runMaintenance().then(() => {
      const interval = (config.retention && config.retention.interval) || 3600000
      if (interval > 0) {
        setInterval(() => this.runMaintenance(), interval)
      }

      callback()
    })
  }

  _rawPingsDays () {
    return (config.retention && config.retention.rawPingsDays) || 7
  }

  async runMaintenance () {
    if (this._maintenanceRunning) {
      logger.log('warn', 'Skipping maintenance run: previous run still in progress')
      return
    }

    this._maintenanceRunning = true
    const started = TimeTracker.getEpochMillis()

    try {
      const now = TimeTracker.getEpochMillis()

      // First run after boot covers the whole raw retention window to close
      // downtime gaps; later runs re-process a small overlap. Idempotent either way.
      const rollupFrom = this._lastRollupTime
        ? this._lastRollupTime - ROLLUP_OVERLAP_MILLIS
        : now - this._rawPingsDays() * MILLIS_PER_DAY

      await this._rollupHourly(new Date(rollupFrom), new Date(now))
      await this._rollupDaily(new Date(Math.min(rollupFrom, now - DAILY_ROLLUP_WINDOW_MILLIS)), new Date(now))

      this._lastRollupTime = now

      if (!config.timeSeries) {
        // Time-series collections expire raw pings via TTL instead
        await this._deleteOldRawPings(new Date(now - this._rawPingsDays() * MILLIS_PER_DAY))
      }

      const keepHourlyDays = (config.retention && config.retention.keepHourlyDays) || 0
      if (keepHourlyDays > 0) {
        await this._pingsHourly.deleteMany({ timestamp: { $lt: new Date(now - keepHourlyDays * MILLIS_PER_DAY) } })
      }

      logger.info(`Database maintenance (rollups + retention) completed in ${TimeTracker.getEpochMillis() - started}ms`)
    } catch (err) {
      logger.log('error', 'Database maintenance failed: %s', err.message)
    } finally {
      this._maintenanceRunning = false
    }
  }

  _rollupHourly (from, to) {
    return this._pings.aggregate([
      { $match: { timestamp: { $gte: from, $lt: to } } },
      {
        $group: {
          _id: {
            serverId: '$serverId',
            timestamp: { $dateTrunc: { date: '$timestamp', unit: 'hour' } }
          },
          // $min/$max ignore nulls, so failed pings never distort the extremes
          minOnlinePlayers: { $min: '$onlinePlayers' },
          maxOnlinePlayers: { $max: '$onlinePlayers' },
          maxPlayers: { $max: '$maxPlayers' },
          // onlinePlayersSum + successfulPings are carried so the daily level
          // re-aggregates exactly (no average of averages)
          onlinePlayersSum: { $sum: { $ifNull: ['$onlinePlayers', 0] } },
          successfulPings: { $sum: { $cond: [{ $eq: ['$onlinePlayers', null] }, 0, 1] } },
          failedPings: { $sum: { $cond: [{ $eq: ['$onlinePlayers', null] }, 1, 0] } }
        }
      },
      {
        $set: {
          serverId: '$_id.serverId',
          timestamp: '$_id.timestamp',
          avgOnlinePlayers: {
            $cond: [
              { $gt: ['$successfulPings', 0] },
              { $divide: ['$onlinePlayersSum', '$successfulPings'] },
              null
            ]
          }
        }
      },
      // Merge on the unique {serverId, timestamp} index; _id stays a plain ObjectId
      { $unset: '_id' },
      { $merge: { into: 'pingsHourly', on: ['serverId', 'timestamp'], whenMatched: 'replace', whenNotMatched: 'insert' } }
    ]).toArray()
  }

  _rollupDaily (from, to) {
    return this._pingsHourly.aggregate([
      { $match: { timestamp: { $gte: from, $lt: to } } },
      {
        $group: {
          _id: {
            serverId: '$serverId',
            timestamp: { $dateTrunc: { date: '$timestamp', unit: 'day' } }
          },
          minOnlinePlayers: { $min: '$minOnlinePlayers' },
          maxOnlinePlayers: { $max: '$maxOnlinePlayers' },
          maxPlayers: { $max: '$maxPlayers' },
          onlinePlayersSum: { $sum: '$onlinePlayersSum' },
          successfulPings: { $sum: '$successfulPings' },
          failedPings: { $sum: '$failedPings' }
        }
      },
      {
        $set: {
          serverId: '$_id.serverId',
          timestamp: '$_id.timestamp',
          avgOnlinePlayers: {
            $cond: [
              { $gt: ['$successfulPings', 0] },
              { $divide: ['$onlinePlayersSum', '$successfulPings'] },
              null
            ]
          }
        }
      },
      { $unset: '_id' },
      { $merge: { into: 'pingsDaily', on: ['serverId', 'timestamp'], whenMatched: 'replace', whenNotMatched: 'insert' } }
    ]).toArray()
  }

  // Deletes raw pings older than the cutoff in bounded time windows,
  // capped per run - the next maintenance run continues where this one stopped
  async _deleteOldRawPings (cutoff) {
    const deleteStart = TimeTracker.getEpochMillis()
    let deletedTotal = 0

    for (let i = 0; i < DELETE_MAX_CHUNKS_PER_RUN; i++) {
      const oldest = await this._pings.find({}, { projection: { timestamp: 1 } }).sort({ timestamp: 1 }).limit(1).next()

      if (!oldest || oldest.timestamp >= cutoff) {
        break
      }

      const windowEnd = new Date(Math.min(oldest.timestamp.getTime() + DELETE_CHUNK_MILLIS, cutoff.getTime()))
      const result = await this._pings.deleteMany({ timestamp: { $lt: windowEnd } })

      deletedTotal += result.deletedCount
    }

    if (deletedTotal > 0) {
      logger.info(`Deleted ${deletedTotal} old pings in ${TimeTracker.getEpochMillis() - deleteStart}ms`)
    }
  }

  // Read path for the long-term rollups
  async getHistory (unit, fromMillis, toMillis) {
    const collection = unit === 'hour' ? this._pingsHourly : this._pingsDaily

    const rows = await collection.find({
      timestamp: {
        $gte: new Date(fromMillis),
        $lte: new Date(toMillis)
      }
    }).sort({ timestamp: 1 }).toArray()

    const data = {}

    for (const row of rows) {
      const serverIdHex = row.serverId.toHexString()

      if (!this._namesByServerIdHex.has(serverIdHex)) {
        // Skip servers no longer present in the servers collection
        continue
      }

      let series = data[serverIdHex]
      if (!series) {
        data[serverIdHex] = series = []
      }

      const totalPings = row.successfulPings + row.failedPings

      series.push({
        timestamp: row.timestamp.getTime(),
        minOnlinePlayers: row.minOnlinePlayers,
        maxOnlinePlayers: row.maxOnlinePlayers,
        avgOnlinePlayers: row.avgOnlinePlayers === null ? null : Math.round(row.avgOnlinePlayers * 10) / 10,
        maxPlayers: row.maxPlayers === undefined ? null : row.maxPlayers,
        uptime: totalPings > 0 ? Math.round((row.successfulPings / totalPings) * 10000) / 10000 : null
      })
    }

    return data
  }
}

module.exports = Database

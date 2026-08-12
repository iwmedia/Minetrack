const http = require('http')
const format = require('util').format

const WebSocket = require('ws')
const finalHttpHandler = require('finalhandler')
const serveStatic = require('serve-static')

const logger = require('./logger')

const config = require('./config')

const HASHED_FAVICON_URL_REGEX = /hashedfavicon_([a-z0-9]{32}).png/g

const HISTORY_RANGE_REGEX = /^([0-9]{1,4})d$/

// Maximum queryable range per unit, and the default when none is given
const HISTORY_UNITS = {
  hour: { maxDays: 90, defaultDays: 7 },
  day: { maxDays: 3650, defaultDays: 365 }
}

const HISTORY_CACHE_MILLIS = 60 * 1000

function getRemoteAddr (req) {
  return req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.connection.remoteAddress
}

class Server {
  static getHashedFaviconUrl (hash) {
    // Format must be compatible with HASHED_FAVICON_URL_REGEX
    return format('/hashedfavicon_%s.png', hash)
  }

  constructor (app) {
    this._app = app
    this._historyCache = new Map()

    this.createHttpServer()
    this.createWebSocketServer()
  }

  createHttpServer () {
    const distServeStatic = serveStatic('dist/')
    const faviconsServeStatic = serveStatic('favicons/')

    this._http = http.createServer((req, res) => {
      logger.log('info', '%s requested: %s', getRemoteAddr(req), req.url)

      // Long-term history API backed by the rollup collections
      if (req.url.startsWith('/api/history')) {
        this.handleHistoryRequest(req, res)
        return
      }

      // Test the URL against a regex for hashed favicon URLs
      // Require only 1 match ([0]) and test its first captured group ([1])
      // Any invalid value or hit miss will pass into static handlers below
      const faviconHash = [...req.url.matchAll(HASHED_FAVICON_URL_REGEX)]

      if (faviconHash.length === 1 && this.handleFaviconRequest(res, faviconHash[0][1])) {
        return
      }

      // Attempt to handle req using distServeStatic, otherwise fail over to faviconServeStatic
      // If faviconServeStatic fails, pass to finalHttpHandler to terminate
      distServeStatic(req, res, () => {
        faviconsServeStatic(req, res, finalHttpHandler(req, res))
      })
    })
  }

  handleFaviconRequest = (res, faviconHash) => {
    for (const serverRegistration of this._app.serverRegistrations) {
      if (serverRegistration.faviconHash && serverRegistration.faviconHash === faviconHash) {
        const buf = Buffer.from(serverRegistration.lastFavicon.split(',')[1], 'base64')

        res.writeHead(200, {
          'Content-Type': 'image/png',
          'Content-Length': buf.length,
          'Cache-Control': 'public, max-age=604800' // Cache hashed favicon for 7 days
        }).end(buf)

        return true
      }
    }

    return false
  }

  handleHistoryRequest = (req, res) => {
    const sendJson = (statusCode, payload) => {
      const body = JSON.stringify(payload)

      res.writeHead(statusCode, {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=60'
      }).end(body)
    }

    if (!config.logToDatabase || !this._app.database) {
      sendJson(404, { error: 'Database logging is not enabled' })
      return
    }

    const url = new URL(req.url, 'http://localhost')

    const unit = url.searchParams.get('unit') === 'hour' ? 'hour' : 'day'
    const unitConfig = HISTORY_UNITS[unit]

    let rangeDays = unitConfig.defaultDays
    const rangeParam = url.searchParams.get('range')

    if (rangeParam) {
      const match = rangeParam.match(HISTORY_RANGE_REGEX)

      if (!match || parseInt(match[1]) < 1 || parseInt(match[1]) > unitConfig.maxDays) {
        sendJson(400, { error: `Invalid range, expected e.g. "30d" with at most ${unitConfig.maxDays}d for unit "${unit}"` })
        return
      }

      rangeDays = parseInt(match[1])
    }

    // Rollups only change once per maintenance run; a short in-process cache
    // keeps page loads from hitting the database
    const cacheKey = `${unit}|${rangeDays}`
    const cached = this._historyCache.get(cacheKey)

    if (cached && cached.expires > Date.now()) {
      sendJson(200, cached.payload)
      return
    }

    const toMillis = Date.now()
    const fromMillis = toMillis - rangeDays * 24 * 60 * 60 * 1000

    this._app.database.getHistory(unit, fromMillis, toMillis).then(data => {
      const payload = {
        unit,
        range: `${rangeDays}d`,
        servers: this._app.serverRegistrations.map(serverRegistration => ({
          id: this._app.database.getServerIdHex(serverRegistration.data.name),
          name: serverRegistration.data.name,
          type: serverRegistration.data.type,
          color: serverRegistration.data.color
        })),
        data
      }

      this._historyCache.set(cacheKey, {
        expires: Date.now() + HISTORY_CACHE_MILLIS,
        payload
      })

      sendJson(200, payload)
    }).catch(err => {
      logger.log('error', 'History request failed: %s', err.message)

      sendJson(500, { error: 'Internal error' })
    })
  }

  createWebSocketServer () {
    this._wss = new WebSocket.Server({
      server: this._http
    })

    this._wss.on('connection', (client, req) => {
      logger.log('info', '%s connected, total clients: %d', getRemoteAddr(req), this.getConnectedClients())

      // Bind disconnect event for logging
      client.on('close', () => {
        logger.log('info', '%s disconnected, total clients: %d', getRemoteAddr(req), this.getConnectedClients())
      })

      // Pass client off to proxy handler
      this._app.handleClientConnection(client)
    })
  }

  listen (host, port) {
    this._http.listen(port, host)

    logger.log('info', 'Started on %s:%d', host, port)
  }

  broadcast (payload) {
    this._wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload)
      }
    })
  }

  getConnectedClients () {
    let count = 0
    this._wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        count++
      }
    })
    return count
  }
}

module.exports = Server

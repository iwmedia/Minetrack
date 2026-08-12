const config = require('../config.json')

// Every config.json key can be overridden by an environment variable named
// after its path: site.port -> SITE_PORT, retention.rawPingsDays ->
// RETENTION_RAW_PINGS_DAYS. Values are coerced to the type of the default.
function toEnvName (path) {
  return path.map(key => key.replace(/([a-z])([A-Z])/g, '$1_$2')).join('_').toUpperCase()
}

function applyEnvOverrides (target, path = []) {
  for (const [key, value] of Object.entries(target)) {
    const keyPath = [...path, key]

    if (value !== null && typeof value === 'object') {
      applyEnvOverrides(value, keyPath)
      continue
    }

    const raw = process.env[toEnvName(keyPath)]
    if (raw === undefined) {
      continue
    }

    if (typeof value === 'boolean') {
      if (raw !== 'true' && raw !== 'false') {
        throw new Error(`Environment override ${toEnvName(keyPath)} must be "true" or "false", got "${raw}"`)
      }
      target[key] = raw === 'true'
    } else if (typeof value === 'number') {
      const parsed = Number(raw)
      if (Number.isNaN(parsed)) {
        throw new Error(`Environment override ${toEnvName(keyPath)} must be a number, got "${raw}"`)
      }
      target[key] = parsed
    } else {
      target[key] = raw
    }
  }
}

applyEnvOverrides(config)

module.exports = config

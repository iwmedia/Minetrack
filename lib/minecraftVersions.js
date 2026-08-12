const logger = require('./logger')

// PrismarineJS/minecraft-data is machine-readable and quickly maintained;
// Mojang offers no official API for protocol version numbers
const SOURCE_URL = 'https://raw.githubusercontent.com/PrismarineJS/minecraft-data/master/data/pc/common/protocolVersions.json'

const REFRESH_INTERVAL_MILLIS = 24 * 60 * 60 * 1000
const STARTUP_FETCH_ATTEMPTS = 3
const STARTUP_RETRY_DELAY_MILLIS = 5000

const RELEASE_NAME_REGEX = /^\d+\.\d+(\.\d+)?$/

// Held in RAM only, replaced atomically on each successful refresh
let versions = { JAVA: [] }

// Compares two release names numerically, e.g. 1.21.10 > 1.21.9
function compareVersionNames (a, b) {
  const partsA = a.split('.').map(Number)
  const partsB = b.split('.').map(Number)

  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const diff = (partsA[i] || 0) - (partsB[i] || 0)
    if (diff !== 0) {
      return diff
    }
  }

  return 0
}

function transform (entries) {
  // Stable releases of the netty era (1.7.2+) only - snapshots use names like
  // "24w33a" and a separate protocol number space, pre-netty versions reuse
  // low protocol numbers and cannot be pinged by mcping-js anyway
  const releases = entries.filter(entry =>
    entry.usesNetty === true &&
    RELEASE_NAME_REGEX.test(entry.minecraftVersion) &&
    Number.isInteger(entry.version) &&
    entry.version >= 4
  )

  // One entry per protocolId, labeled with the newest version sharing it
  // (e.g. protocol 772 -> "1.21.8", not "1.21.7")
  const namesByProtocolId = new Map()

  for (const release of releases) {
    const existing = namesByProtocolId.get(release.version)
    if (!existing || compareVersionNames(release.minecraftVersion, existing) > 0) {
      namesByProtocolId.set(release.version, release.minecraftVersion)
    }
  }

  return {
    JAVA: [...namesByProtocolId.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([protocolId, name]) => ({ name, protocolId }))
  }
}

async function fetchVersions () {
  const response = await fetch(SOURCE_URL)
  if (!response.ok) {
    throw new Error(`Unexpected response: ${response.status} ${response.statusText}`)
  }

  const transformed = transform(await response.json())

  if (transformed.JAVA.length === 0) {
    throw new Error('Fetched version list is empty')
  }

  return transformed
}

async function refresh () {
  try {
    const next = await fetchVersions()

    // Guard against source regressions truncating the list; appends keep the
    // protocolIndex values already sent to connected clients stable
    if (next.JAVA.length < versions.JAVA.length) {
      logger.log('warn', 'Fetched version list shrank (%d -> %d), keeping the current list', versions.JAVA.length, next.JAVA.length)
      return
    }

    if (next.JAVA.length > versions.JAVA.length) {
      const newest = next.JAVA[next.JAVA.length - 1]
      logger.info(`Minecraft version list updated: ${versions.JAVA.length} -> ${next.JAVA.length} entries, newest: ${newest.name} (protocol ${newest.protocolId})`)
    }

    versions = next
  } catch (err) {
    logger.log('error', 'Cannot refresh Minecraft version list, keeping the current list: %s', err.message)
  }
}

// Fetches the initial version list; the ping scheduler cannot run without it,
// so startup fails hard after a few attempts. Afterwards a daily refresh keeps
// the list current, keeping the last good list when a refresh fails.
async function init () {
  for (let attempt = 1; ; attempt++) {
    try {
      versions = await fetchVersions()

      const newest = versions.JAVA[versions.JAVA.length - 1]
      logger.info(`Loaded ${versions.JAVA.length} Minecraft versions, newest: ${newest.name} (protocol ${newest.protocolId})`)

      break
    } catch (err) {
      logger.log('error', 'Cannot fetch Minecraft version list (attempt %d/%d): %s', attempt, STARTUP_FETCH_ATTEMPTS, err.message)

      if (attempt >= STARTUP_FETCH_ATTEMPTS) {
        throw err
      }

      await new Promise(resolve => setTimeout(resolve, STARTUP_RETRY_DELAY_MILLIS))
    }
  }

  setInterval(refresh, REFRESH_INTERVAL_MILLIS)
}

function get () {
  return versions
}

module.exports = {
  init,
  get
}

// Long-term history from the /api/history rollups, normalised so it can be fed
// to the same uPlot instance as the live data.

// span is either a trailing range in days or an exact { from, to } window in
// epoch millis
export function fetchHistory (unit, span) {
  const params = new URLSearchParams({ unit })

  if (typeof span === 'number') {
    params.set('range', `${span}d`)
  } else {
    params.set('from', span.from)
    params.set('to', span.to)
  }

  return window.fetch(`/api/history?${params}`).then(response => {
    return response.json().catch(() => ({})).then(body => {
      if (!response.ok) {
        throw new Error(body.error || `Request failed with status ${response.status}`)
      }

      return body
    })
  })
}

// Each server comes back with its own bucket list, so they are merged onto one
// sorted axis with nulls for gaps. Buckets are milliseconds in the payload and
// seconds in the result, which is what uPlot's time scale expects.
export function alignHistory (payload, serverRegistrations) {
  const rowsByName = new Map()

  for (const server of payload.servers) {
    // id is null for servers that have no document yet
    const rows = server.id ? payload.data[server.id] : null

    if (rows && rows.length > 0) {
      rowsByName.set(server.name, rows)
    }
  }

  const bucketSet = new Set()

  for (const rows of rowsByName.values()) {
    for (const row of rows) {
      bucketSet.add(row.timestamp)
    }
  }

  const buckets = [...bucketSet].sort((a, b) => a - b)

  // Indexed by serverId, matching the series order of the plot. Built from the
  // registrations rather than the payload so the array is never sparse.
  const series = []
  const detail = []

  for (const serverRegistration of serverRegistrations) {
    const rows = rowsByName.get(serverRegistration.data.name)
    const rowsByBucket = new Map()

    if (rows) {
      for (const row of rows) {
        rowsByBucket.set(row.timestamp, row)
      }
    }

    series[serverRegistration.serverId] = buckets.map(bucket => {
      const row = rowsByBucket.get(bucket)
      return row ? row.avgOnlinePlayers : null
    })

    detail[serverRegistration.serverId] = buckets.map(bucket => rowsByBucket.get(bucket) || null)
  }

  return {
    timestamps: buckets.map(bucket => Math.floor(bucket / 1000)),
    series,
    detail,
    unit: payload.unit,
    isEmpty: buckets.length === 0
  }
}

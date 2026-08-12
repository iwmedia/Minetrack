// Chart colours come from the CSS custom properties in css/main.css so the
// palette has one source of truth. The literals are a safety net only.
const FALLBACKS = {
  '--signal': '#37E0C3',
  '--silver-dim': '#7A8B91',
  '--rule': '#1E2C31',
  '--series-1': '#37E0C3',
  '--series-2': '#4FA8FF',
  '--series-3': '#A78BFA',
  '--series-4': '#F2C14E',
  '--series-5': '#FF7A6B',
  '--series-6': '#6EE787',
  '--series-7': '#E879C7',
  '--series-8': '#8FA3AD'
}

const SERIES_PROPERTIES = [
  '--series-1',
  '--series-2',
  '--series-3',
  '--series-4',
  '--series-5',
  '--series-6',
  '--series-7',
  '--series-8'
]

export const CHART_FONT = '11px "IBM Plex Mono", ui-monospace, monospace'

let cachedTheme

function readProperty (name) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()

  return value || FALLBACKS[name]
}

// Read lazily: the first call happens once the socket has delivered data
export function getChartTheme () {
  if (!cachedTheme) {
    cachedTheme = {
      signal: readProperty('--signal'),
      axis: readProperty('--silver-dim'),
      grid: readProperty('--rule'),
      series: SERIES_PROPERTIES.map(readProperty)
    }
  }

  return cachedTheme
}

// Servers without a "color" in their servers document get a series colour by id. Shared
// by the percentage bar and the graph so a server looks the same in both.
export function getServerColor (serverRegistration) {
  if (serverRegistration.data.color) {
    return serverRegistration.data.color
  }

  const { series } = getChartTheme()

  return series[serverRegistration.serverId % series.length]
}

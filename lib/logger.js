const { createLogger, format, transports } = require('winston')

const logger = createLogger({
  format: format.combine(
    format.splat(),
    format.timestamp({
      format: () => {
        const date = new Date()
        return date.toLocaleTimeString() + ' ' + date.toLocaleDateString()
      }
    })
  ),
  transports: [
    new transports.File({
      filename: 'minetrack.log',
      format: format.json()
    }),
    new transports.Console({
      format: format.combine(
        format.colorize(),
        format.printf(({ timestamp, level, message }) => `${timestamp} - ${level}: ${message}`)
      )
    })
  ]
})

module.exports = logger

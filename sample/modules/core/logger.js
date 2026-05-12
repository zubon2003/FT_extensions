const winston = require('winston');

const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(
        winston.format.colorize(),
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.splat(),
        winston.format.printf(info => {
            const { timestamp, level, message, ...args } = info;
            const ts = timestamp.slice(0, 19).replace('T', ' ');
            const m = typeof message === 'object' ? JSON.stringify(message) : message;
            const a = Object.keys(args).length ? ' ' + JSON.stringify(args) : '';
            return `${ts} [${level}]: ${m}${a}`;
        })
    ),
    transports: [new winston.transports.Console()]
});

module.exports = logger;

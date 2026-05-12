const fs = require('fs');
const path = require('path');
const winston = require('winston');

// Resolve log directory relative to the receiver's working directory so the
// file lives next to config.json. Created lazily; the file transport itself
// won't create missing parent directories.
const LOG_DIR = path.resolve(process.cwd(), 'log');
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (_e) { /* ignore */ }
const LOG_FILE = path.join(LOG_DIR, 'server.log');

const plainFormat = winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.splat(),
    winston.format.printf(info => {
        const { timestamp, level, message, ...args } = info;
        const ts = timestamp.slice(0, 19).replace('T', ' ');
        const m = typeof message === 'object' ? JSON.stringify(message) : message;
        const a = Object.keys(args).length ? ' ' + JSON.stringify(args) : '';
        return `${ts} [${level}]: ${m}${a}`;
    })
);

const colorFormat = winston.format.combine(
    winston.format.colorize(),
    plainFormat
);

const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    transports: [
        new winston.transports.Console({ format: colorFormat }),
        // File transport intentionally has no rotation — winston-daily-rotate
        // would pull in a dep. 10 MB × 5 files gives ~50 MB of history before
        // the oldest is dropped, which is plenty for a race day.
        new winston.transports.File({
            filename: LOG_FILE,
            format: plainFormat,
            maxsize: 10 * 1024 * 1024,
            maxFiles: 5,
            tailable: true,
        }),
    ],
});

module.exports = logger;

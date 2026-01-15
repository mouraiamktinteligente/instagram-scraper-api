/**
 * Winston Logger Configuration
 * Provides structured logging with multiple transports
 */

const winston = require('winston');
const path = require('path');

const config = require('../config');

// Define log format
const logFormat = winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.printf(({ timestamp, level, message, stack, ...meta }) => {
        let log = `${timestamp} [${level.toUpperCase()}]: ${message}`;

        // Add stack trace for errors
        if (stack) {
            log += `\n${stack}`;
        }

        // Add metadata if present
        if (Object.keys(meta).length > 0) {
            log += ` ${JSON.stringify(meta)}`;
        }

        return log;
    })
);

// JSON format for production
const jsonFormat = winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
);

// Create transports array
const transports = [
    // Console transport (always enabled)
    new winston.transports.Console({
        format: config.isProduction ? jsonFormat : winston.format.combine(
            winston.format.colorize(),
            logFormat
        ),
    }),
];

// Add file transport in production
if (config.isProduction) {
    transports.push(
        new winston.transports.File({
            filename: path.join('logs', 'error.log'),
            level: 'error',
            format: jsonFormat,
            maxsize: 5242880, // 5MB
            maxFiles: 5,
        }),
        new winston.transports.File({
            filename: path.join('logs', 'combined.log'),
            format: jsonFormat,
            maxsize: 5242880, // 5MB
            maxFiles: 5,
        })
    );
}

// Create logger instance
const logger = winston.createLogger({
    level: config.logLevel,
    format: logFormat,
    transports,
    // Don't exit on handled exceptions
    exitOnError: false,
});

// Create child logger for specific modules
logger.child = (metadata) => {
    return logger.child(metadata);
};

/**
 * Log scraping activity
 * @param {string} action - Action being performed
 * @param {Object} data - Additional data
 */
logger.scrape = (action, data = {}) => {
    logger.info(`[SCRAPE] ${action}`, data);
};

/**
 * Log queue activity
 * @param {string} action - Action being performed
 * @param {Object} data - Additional data
 */
logger.queue = (action, data = {}) => {
    logger.info(`[QUEUE] ${action}`, data);
};

/**
 * Log API activity
 * @param {string} action - Action being performed
 * @param {Object} data - Additional data
 */
logger.api = (action, data = {}) => {
    logger.info(`[API] ${action}`, data);
};

module.exports = logger;

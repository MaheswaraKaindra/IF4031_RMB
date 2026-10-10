import pino from 'pino';
import { config } from './config.js';

export const logger = pino({
    level: config.logLevel,
    base: { service: 'client-api' },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
        level: (label) => ({ level: label }),
    },
});

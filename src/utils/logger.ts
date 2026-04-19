// logger.ts

import winston from 'winston';
import { config } from '../config';

type ContextLogger = {
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
  debug: (message: string, meta?: Record<string, unknown>) => void;
};

const devFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.colorize({ level: true }),
  winston.format.printf(
    ({ timestamp, level, message, ...meta }: winston.Logform.TransformableInfo): string => {
      const metaStr = Object.keys(meta).length > 0 ? '  ' + JSON.stringify(meta, null, 0) : '';
      return `${timestamp} [${level}] ${message}${metaStr}`;
    },
  ),
);

//   json format for production
// {"timestamp":"2024-01-15T10:30:00.000Z","level":"info","message":"[redis] Connected"}

const prodFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.json(),
);

export const logger = winston.createLogger({
  // Individual tests can enable logging by adjusting the level.
  level: config.isTest ? 'silent' : config.isDevelopment ? 'debug' : 'info',

  format: config.isDevelopment ? devFormat : prodFormat,

  transports: [
    // Always log to stdout — in containers, stdout is collected by the
    // orchestrator (Docker, Kubernetes) and forwarded to the log aggregator.
    new winston.transports.Console({
      silent: config.isTest,
    }),
  ],

  // Do not exit on handled exceptions — let the error middleware decide.
  exitOnError: false,
});

export function createContextLogger(context: string): ContextLogger {
  return {
    info: (message: string, meta?: Record<string, unknown>): void => {
      logger.info(`[${context}] ${message}`, meta);
    },

    warn: (message: string, meta?: Record<string, unknown>): void => {
      logger.warn(`[${context}] ${message}`, meta);
    },

    error: (message: string, meta?: Record<string, unknown>): void => {
      logger.error(`[${context}] ${message}`, meta);
    },

    debug: (message: string, meta?: Record<string, unknown>): void => {
      logger.debug(`[${context}] ${message}`, meta);
    },
  };
}

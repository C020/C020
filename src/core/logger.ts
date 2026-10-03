import { pino, type Logger } from 'pino';

const level = process.env.LOG_LEVEL ?? 'info';
const pretty = process.env.LOG_PRETTY === 'true' || (process.env.NODE_ENV !== 'production' && process.stdout.isTTY);

function createLogger(): Logger {
  if (pretty) {
    try {
      return pino({ level, transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss' } } });
    } catch {
      // pino-pretty is a dev dependency; fall back to JSON logs when it is not installed.
    }
  }
  return pino({ level });
}

export const logger = createLogger();

export function childLogger(module: string): Logger {
  return logger.child({ module });
}

export type { Logger };

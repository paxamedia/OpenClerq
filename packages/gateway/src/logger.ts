/**
 * Structured logging. Outputs key-value pairs for easy parsing.
 * Set CLERQ_LOG_JSON=1 for JSON lines.
 * Feeds log-stream for real-time observability when enabled.
 */

import { appendLog } from './log-stream.js';

const useJson = process.env.CLERQ_LOG_JSON === '1' || process.env.CLERQ_LOG_JSON === 'true';
const streamEnabled = process.env.CLERQ_LOG_STREAM !== '0';

function formatMessage(level: string, message: string, data?: Record<string, unknown>): string {
  const timestamp = new Date().toISOString();
  if (useJson) {
    return JSON.stringify({ ts: timestamp, level, msg: message, ...data });
  }
  const extra = data && Object.keys(data).length > 0 ? ` ${JSON.stringify(data)}` : '';
  return `[${timestamp}] [${level}] ${message}${extra}`;
}

function emitStream(level: 'INFO' | 'WARN' | 'ERROR', message: string, data?: Record<string, unknown>): void {
  if (streamEnabled) appendLog(level, message, data);
}

export const logger = {
  info(message: string, data?: Record<string, unknown>): void {
    console.log(formatMessage('INFO', message, data));
    emitStream('INFO', message, data);
  },
  warn(message: string, data?: Record<string, unknown>): void {
    console.warn(formatMessage('WARN', message, data));
    emitStream('WARN', message, data);
  },
  error(message: string, data?: Record<string, unknown>): void {
    console.error(formatMessage('ERROR', message, data));
    emitStream('ERROR', message, data);
  },
};

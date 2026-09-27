import pino from 'pino';
import { config } from '../config';

export const logger = pino({
  level: config.NODE_ENV === 'test' ? 'silent' : config.LOG_LEVEL,
  base: { service: process.env.SERVICE_NAME ?? (/worker\.[jt]s$/.test(process.argv[1] ?? '') ? 'worker' : 'api') },
  redact: {
    paths: ['req.headers.cookie', 'req.headers.authorization', '*.smtpPass', '*.accessToken', '*.webhookUrl'],
    censor: '[redacted]',
  },
  transport: config.isProd || config.NODE_ENV === 'test' ? undefined : { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss.l' } },
});

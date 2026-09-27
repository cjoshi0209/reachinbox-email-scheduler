import 'dotenv/config';
import { z } from 'zod';

const optional = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== '' ? v.trim() : undefined));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  API_URL: z.url().default('http://localhost:4000'),
  FRONTEND_URL: z.url().default('http://localhost:3000'),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
  ELASTICSEARCH_URL: z.url().default('http://localhost:9200'),
  ELASTICSEARCH_INDEX: z.string().min(1).default('emails'),
  QUEUE_NAME: z.string().regex(/^[\w-]+$/).default('email-send'),

  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'ENCRYPTION_KEY must be 32 bytes, base64 encoded'),

  GOOGLE_CLIENT_ID: optional,
  GOOGLE_CLIENT_SECRET: optional,
  GOOGLE_REDIRECT_URI: optional,

  SLACK_CLIENT_ID: optional,
  SLACK_CLIENT_SECRET: optional,
  SLACK_REDIRECT_URI: optional,

  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(5),
  MIN_EMAIL_DELAY_MS: z.coerce.number().int().min(0).default(2000),
  MAX_EMAILS_PER_HOUR: z.coerce.number().int().min(1).default(200),
  EMAIL_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(3),
  EMAIL_BACKOFF_MS: z.coerce.number().int().min(0).default(5000),
  STALE_PROCESSING_MS: z.coerce.number().int().min(10_000).default(300_000),

  BULL_BOARD_USER: optional,
  BULL_BOARD_PASSWORD: optional,
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // Fail fast with a readable message; never print secret values.
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
  console.error(`Invalid environment configuration:\n${issues}`);
  process.exit(1);
}

const env = parsed.data;

export const config = {
  ...env,
  isProd: env.NODE_ENV === 'production',
  googleRedirectUri: env.GOOGLE_REDIRECT_URI ?? `${env.API_URL}/auth/google/callback`,
  slackRedirectUri: env.SLACK_REDIRECT_URI ?? `${env.API_URL}/auth/slack/callback`,
  googleEnabled: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
  slackEnabled: Boolean(env.SLACK_CLIENT_ID && env.SLACK_CLIENT_SECRET),
};

export type AppConfig = typeof config;

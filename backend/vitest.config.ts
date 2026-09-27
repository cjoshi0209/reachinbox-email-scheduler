import { defineConfig } from 'vitest/config';

/**
 * Integration tests use the real Postgres / Redis / Elasticsearch from docker-compose,
 * but fully isolated: a separate Postgres schema, Redis DB 1, a dedicated queue name and
 * Elasticsearch index. They never touch dev data or compete with a running dev worker.
 */
export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: ['tests/globalSetup.ts'],
    setupFiles: ['tests/setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://reachinbox:reachinbox@localhost:5432/reachinbox?schema=test',
      REDIS_URL: 'redis://localhost:6379/1',
      ELASTICSEARCH_INDEX: 'emails_test',
      QUEUE_NAME: 'email-send-test',
      SESSION_SECRET: 'test-session-secret-that-is-at-least-32-characters',
      ENCRYPTION_KEY: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
      MIN_EMAIL_DELAY_MS: '0',
      MAX_EMAILS_PER_HOUR: '1000',
      EMAIL_MAX_ATTEMPTS: '3',
      EMAIL_BACKOFF_MS: '100',
      STALE_PROCESSING_MS: '60000',
      FRONTEND_URL: 'http://localhost:3000',
      // Hermetic: never pick up real OAuth apps from a developer's .env.
      GOOGLE_CLIENT_ID: '',
      GOOGLE_CLIENT_SECRET: '',
      SLACK_CLIENT_ID: '',
      SLACK_CLIENT_SECRET: '',
      BULL_BOARD_USER: 'admin',
      BULL_BOARD_PASSWORD: 'secret-pass',
    },
  },
});

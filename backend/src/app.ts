import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { ZodError } from 'zod';
import { BULL_BOARD_PATH, bullBoardAuth, createBullBoardRouter } from './admin/bullBoard';
import { authRouter } from './auth/authRoutes';
import { config } from './config';
import { emailRouter } from './emails/emailRoutes';
import { HttpError } from './lib/errors';
import { logger } from './lib/logger';
import { prisma } from './lib/prisma';
import { redis } from './lib/redis';
import { es } from './search/elastic';
import { senderRouter } from './senders/senderRoutes';
import { slackRouter } from './slack/slackRoutes';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  // Bull Board ships its own inline scripts/styles, so it is mounted before helmet's CSP.
  app.use(BULL_BOARD_PATH, cookieParser(), bullBoardAuth, createBullBoardRouter());

  app.use(helmet());
  app.use(cors({ origin: config.FRONTEND_URL, credentials: true }));
  app.use(express.json({ limit: '2mb' }));
  app.use(cookieParser());
  app.use(
    pinoHttp({
      logger,
      autoLogging: { ignore: (req) => req.url === '/health' },
      customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
    }),
  );

  app.get('/health', async (_req, res) => {
    const check = async (fn: () => Promise<unknown>) => {
      try {
        await fn();
        return 'ok';
      } catch {
        return 'down';
      }
    };
    const [postgres, redisStatus, elasticsearch] = await Promise.all([
      check(() => prisma.$queryRaw`SELECT 1`),
      check(() => redis.ping()),
      check(() => es.ping()),
    ]);
    const healthy = postgres === 'ok' && redisStatus === 'ok';
    res.status(healthy ? 200 : 503).json({
      status: healthy ? (elasticsearch === 'ok' ? 'ok' : 'degraded') : 'down',
      postgres,
      redis: redisStatus,
      elasticsearch,
      time: new Date().toISOString(),
    });
  });

  app.use(authRouter);
  app.use(slackRouter);
  app.use(emailRouter);
  app.use(senderRouter);

  app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) {
      return res.status(400).json({
        error: 'Validation failed',
        details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: err.message, details: err.details });
    }
    if (err instanceof SyntaxError && 'body' in err) {
      return res.status(400).json({ error: 'Malformed JSON body' });
    }
    req.log?.error({ err }, 'Unhandled error');
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

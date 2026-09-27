import { timingSafeEqual } from 'node:crypto';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import type { NextFunction, Request, Response } from 'express';
import { loadUser } from '../auth/session';
import { config } from '../config';
import { emailQueue } from '../queue/emailQueue';

export const BULL_BOARD_PATH = '/admin/queues';

function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function basicAuthOk(req: Request): boolean {
  if (!config.BULL_BOARD_USER || !config.BULL_BOARD_PASSWORD) return false;
  const header = req.get('authorization');
  if (!header?.startsWith('Basic ')) return false;
  const [user = '', pass = ''] = Buffer.from(header.slice(6), 'base64').toString().split(':');
  return safeEqual(user, config.BULL_BOARD_USER) && safeEqual(pass, config.BULL_BOARD_PASSWORD);
}

/** Bull Board is visible to logged-in dashboard users, or via optional HTTP Basic credentials. */
export async function bullBoardAuth(req: Request, res: Response, next: NextFunction) {
  if (basicAuthOk(req)) return next();
  if (await loadUser(req)) return next();
  if (config.BULL_BOARD_USER && config.BULL_BOARD_PASSWORD) {
    res.set('WWW-Authenticate', 'Basic realm="Bull Board"');
    return res.status(401).send('Authentication required');
  }
  res.redirect(`${config.FRONTEND_URL}/login?next=bullboard`);
}

export function createBullBoardRouter() {
  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath(BULL_BOARD_PATH);
  createBullBoard({ queues: [new BullMQAdapter(emailQueue)], serverAdapter });
  return serverAdapter.getRouter();
}

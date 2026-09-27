import { Router } from 'express';
import { config } from '../config';
import { currentUser, loadUser, requireAuth, signToken, verifyToken } from '../auth/session';
import { HttpError } from '../lib/errors';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { completeSlackOAuth, disconnectSlack, notifyUser, slackAuthorizeUrl } from './slackService';

export const slackRouter = Router();

const dashboard = (status: string) => `${config.FRONTEND_URL}/dashboard?slack=${encodeURIComponent(status)}`;

slackRouter.get('/auth/slack', async (req, res) => {
  const user = await loadUser(req);
  if (!user) return res.redirect(`${config.FRONTEND_URL}/login`);
  if (!config.slackEnabled) return res.redirect(dashboard('not_configured'));
  // State is a signed token carrying the user id, so the callback works even if it lands
  // on a different host (Slack requires an HTTPS redirect, e.g. via a tunnel) without the session cookie.
  const state = await signToken({ sub: user.id, purpose: 'slack_oauth' }, 600);
  res.redirect(slackAuthorizeUrl(state));
});

slackRouter.get('/auth/slack/callback', async (req, res) => {
  const { code, state, error } = req.query as Record<string, string | undefined>;
  if (error) return res.redirect(dashboard(error === 'access_denied' ? 'denied' : 'error'));
  const claims = state ? await verifyToken(state, 'slack_oauth') : null;
  if (!code || !claims) return res.redirect(dashboard('invalid_state'));
  try {
    await completeSlackOAuth(claims.sub, code);
    res.redirect(dashboard('connected'));
  } catch (err) {
    logger.error({ err }, 'Slack OAuth callback failed');
    res.redirect(dashboard('error'));
  }
});

slackRouter.get('/api/slack/status', requireAuth, async (req, res) => {
  const conn = await prisma.slackConnection.findUnique({ where: { userId: currentUser(req).id } });
  res.json({
    configured: config.slackEnabled,
    connected: Boolean(conn),
    teamName: conn?.teamName ?? null,
    channelName: conn?.channelName ?? null,
    connectedAt: conn?.createdAt ?? null,
  });
});

slackRouter.delete('/api/slack/disconnect', requireAuth, async (req, res) => {
  await disconnectSlack(currentUser(req).id);
  res.status(204).end();
});

/** Sends a test message so the connection can be verified from the dashboard. */
slackRouter.post('/api/slack/test', requireAuth, async (req, res) => {
  const user = currentUser(req);
  const ok = await notifyUser(user.id, { text: `:white_check_mark: ReachInbox scheduler is connected for ${user.email}.` });
  if (!ok) throw new HttpError(409, 'Slack is not connected or the message could not be delivered');
  res.json({ ok: true });
});

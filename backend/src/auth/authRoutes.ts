import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { OAuth2Client } from 'google-auth-library';
import { config } from '../config';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { clearSessionCookie, currentUser, requireAuth, setSessionCookie } from './session';

const STATE_COOKIE = 'rb_oauth_state';

const google = new OAuth2Client({
  clientId: config.GOOGLE_CLIENT_ID,
  clientSecret: config.GOOGLE_CLIENT_SECRET,
  redirectUri: config.googleRedirectUri,
});

const loginRedirect = (error: string) => `${config.FRONTEND_URL}/login?error=${encodeURIComponent(error)}`;

export const authRouter = Router();

authRouter.get('/auth/google', (_req, res) => {
  if (!config.googleEnabled) return res.redirect(loginRedirect('google_not_configured'));
  const state = randomBytes(24).toString('base64url');
  res.cookie(STATE_COOKIE, state, { httpOnly: true, secure: config.isProd, sameSite: 'lax', maxAge: 10 * 60 * 1000, path: '/auth' });
  const url = google.generateAuthUrl({
    access_type: 'online',
    scope: ['openid', 'email', 'profile'],
    state,
    prompt: 'select_account',
  });
  res.redirect(url);
});

authRouter.get('/auth/google/callback', async (req, res) => {
  const { code, state, error } = req.query as Record<string, string | undefined>;
  const expected = req.cookies?.[STATE_COOKIE] as string | undefined;
  res.clearCookie(STATE_COOKIE, { path: '/auth' });

  if (error) return res.redirect(loginRedirect(error));
  if (!code || !state || !expected || state.length !== expected.length || !timingSafeEqual(Buffer.from(state), Buffer.from(expected))) {
    return res.redirect(loginRedirect('invalid_state'));
  }

  try {
    const { tokens } = await google.getToken(code);
    if (!tokens.id_token) throw new Error('No id_token returned');
    const ticket = await google.verifyIdToken({ idToken: tokens.id_token, audience: config.GOOGLE_CLIENT_ID });
    const p = ticket.getPayload();
    if (!p?.sub || !p.email || !p.email_verified) throw new Error('Google account email not verified');

    const profile = { email: p.email, name: p.name ?? p.email, avatarUrl: p.picture ?? null };
    const user = await prisma.user.upsert({
      where: { googleId: p.sub },
      create: { googleId: p.sub, ...profile },
      update: profile,
    });
    await setSessionCookie(res, user.id);
    logger.info({ userId: user.id }, 'User logged in with Google');
    res.redirect(`${config.FRONTEND_URL}/dashboard`);
  } catch (err) {
    logger.error({ err }, 'Google OAuth callback failed');
    res.redirect(loginRedirect('google_auth_failed'));
  }
});

authRouter.post('/auth/logout', (_req, res) => {
  clearSessionCookie(res);
  res.status(204).end();
});

authRouter.get('/api/auth/me', requireAuth, (req, res) => {
  const u = currentUser(req);
  res.json({ id: u.id, email: u.email, name: u.name, avatarUrl: u.avatarUrl });
});

/** Lets the login page tell the user when OAuth isn't configured yet. */
authRouter.get('/api/auth/providers', (_req, res) => {
  res.json({ google: config.googleEnabled, slack: config.slackEnabled });
});

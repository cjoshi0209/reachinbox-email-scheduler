import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { OAuth2Client, type TokenPayload } from 'google-auth-library';
import { z } from 'zod';
import { config } from '../config';
import { HttpError } from '../lib/errors';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { clearSessionCookie, currentUser, requireAuth, setSessionCookie } from './session';

const STATE_COOKIE = 'rb_oauth_state';
const NONCE_COOKIE = 'rb_google_nonce';

const google = new OAuth2Client({
  clientId: config.GOOGLE_CLIENT_ID,
  clientSecret: config.GOOGLE_CLIENT_SECRET,
  redirectUri: config.googleRedirectUri,
});

const loginRedirect = (error: string) => `${config.FRONTEND_URL}/login?error=${encodeURIComponent(error)}`;
const safeEqual = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Verifies a Google-signed ID token for our client id and upserts the user. */
async function loginWithIdToken(idToken: string, expectedNonce?: string) {
  const ticket = await google.verifyIdToken({ idToken, audience: config.GOOGLE_CLIENT_ID });
  const p: TokenPayload | undefined = ticket.getPayload();
  if (!p?.sub || !p.email || !p.email_verified) throw new Error('Google account email not verified');
  if (expectedNonce !== undefined && (!p.nonce || !safeEqual(p.nonce, expectedNonce))) throw new Error('Nonce mismatch');
  const profile = { email: p.email, name: p.name ?? p.email, avatarUrl: p.picture ?? null };
  return prisma.user.upsert({ where: { googleId: p.sub }, create: { googleId: p.sub, ...profile }, update: profile });
}

export const authRouter = Router();

// ------------------------------------------------ OAuth 2.0 authorization-code flow
// Used when the server holds the client secret (local setup in the README).

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
  if (!code || !state || !expected || !safeEqual(state, expected)) {
    return res.redirect(loginRedirect('invalid_state'));
  }

  try {
    const { tokens } = await google.getToken(code);
    if (!tokens.id_token) throw new Error('No id_token returned');
    const user = await loginWithIdToken(tokens.id_token);
    await setSessionCookie(res, user.id);
    logger.info({ userId: user.id, flow: 'code' }, 'User logged in with Google');
    res.redirect(`${config.FRONTEND_URL}/dashboard`);
  } catch (err) {
    logger.error({ err }, 'Google OAuth callback failed');
    res.redirect(loginRedirect('google_auth_failed'));
  }
});

// ------------------------------------------------ Google Identity Services (ID token) flow
// Needs only the public client id: the browser receives a Google-signed ID token and the
// server verifies signature, audience, expiry and a one-time nonce. Used on hosts that
// don't hold the client secret.

authRouter.get('/api/auth/google/nonce', (_req, res) => {
  const nonce = randomBytes(24).toString('base64url');
  res.cookie(NONCE_COOKIE, nonce, { httpOnly: true, secure: config.isProd, sameSite: 'lax', maxAge: 10 * 60 * 1000, path: '/api/auth' });
  res.json({ nonce });
});

const idTokenSchema = z.object({ credential: z.string().min(20).max(8192) }).strict();

authRouter.post('/api/auth/google/token', async (req, res) => {
  if (!config.GOOGLE_CLIENT_ID) throw new HttpError(503, 'Google sign-in is not configured');
  const { credential } = idTokenSchema.parse(req.body);
  const nonce = req.cookies?.[NONCE_COOKIE] as string | undefined;
  res.clearCookie(NONCE_COOKIE, { path: '/api/auth' });
  if (!nonce) throw new HttpError(400, 'Sign-in session expired, please try again');
  try {
    const user = await loginWithIdToken(credential, nonce);
    await setSessionCookie(res, user.id);
    logger.info({ userId: user.id, flow: 'id_token' }, 'User logged in with Google');
    res.json({ ok: true });
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'Google ID token rejected');
    throw new HttpError(401, 'Google sign-in failed');
  }
});

// ------------------------------------------------ session

authRouter.post('/auth/logout', (_req, res) => {
  clearSessionCookie(res);
  res.status(204).end();
});

authRouter.get('/api/auth/me', requireAuth, (req, res) => {
  const u = currentUser(req);
  res.json({ id: u.id, email: u.email, name: u.name, avatarUrl: u.avatarUrl });
});

/** Tells the login page which Google flow is available. */
authRouter.get('/api/auth/providers', (_req, res) => {
  res.json({
    google: Boolean(config.GOOGLE_CLIENT_ID),
    googleRedirect: config.googleEnabled,
    googleClientId: config.GOOGLE_CLIENT_ID ?? null,
    slack: config.slackEnabled,
  });
});

import type { NextFunction, Request, Response } from 'express';
import { SignJWT, jwtVerify } from 'jose';
import type { User } from '@prisma/client';
import { config } from '../config';
import { unauthorized } from '../lib/errors';
import { prisma } from '../lib/prisma';

export const SESSION_COOKIE = 'rb_session';
const SESSION_TTL_S = 7 * 24 * 3600;
const secret = new TextEncoder().encode(config.SESSION_SECRET);

/** Signed, short-lived token for OAuth `state` or sessions. `purpose` prevents token confusion. */
export async function signToken(claims: { sub: string; purpose: string; nonce?: string }, ttlSeconds: number): Promise<string> {
  return new SignJWT({ purpose: claims.purpose, nonce: claims.nonce })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(secret);
}

export async function verifyToken(token: string, purpose: string): Promise<{ sub: string; nonce?: string } | null> {
  try {
    const { payload } = await jwtVerify(token, secret, { algorithms: ['HS256'] });
    if (payload.purpose !== purpose || !payload.sub) return null;
    return { sub: payload.sub, nonce: typeof payload.nonce === 'string' ? payload.nonce : undefined };
  } catch {
    return null;
  }
}

export const createSessionToken = (userId: string) => signToken({ sub: userId, purpose: 'session' }, SESSION_TTL_S);

export async function setSessionCookie(res: Response, userId: string) {
  res.cookie(SESSION_COOKIE, await createSessionToken(userId), {
    httpOnly: true,
    secure: config.isProd,
    sameSite: 'lax',
    maxAge: SESSION_TTL_S * 1000,
    path: '/',
  });
}

export function clearSessionCookie(res: Response) {
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, secure: config.isProd, sameSite: 'lax', path: '/' });
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: User;
  }
}

export async function loadUser(req: Request): Promise<User | null> {
  const token = req.cookies?.[SESSION_COOKIE] as string | undefined;
  if (!token) return null;
  const claims = await verifyToken(token, 'session');
  if (!claims) return null;
  return prisma.user.findUnique({ where: { id: claims.sub } });
}

export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const user = await loadUser(req);
  if (!user) return next(unauthorized());
  req.user = user;
  next();
}

/** Narrowing helper for handlers mounted behind requireAuth. */
export function currentUser(req: Request): User {
  if (!req.user) throw unauthorized();
  return req.user;
}

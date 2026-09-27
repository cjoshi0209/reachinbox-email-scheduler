import nodemailer from 'nodemailer';
import type { Sender } from '@prisma/client';
import { z } from 'zod';
import { encrypt } from '../lib/crypto';
import { HttpError } from '../lib/errors';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';

export const createSenderSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    /** Omit SMTP details to auto-provision a fresh Ethereal test inbox. */
    smtp: z
      .object({
        host: z.string().trim().min(1),
        port: z.coerce.number().int().min(1).max(65535),
        secure: z.boolean().default(false),
        user: z.string().trim().min(1),
        pass: z.string().min(1),
        email: z.email().optional(),
      })
      .optional(),
  })
  .strict();

export type CreateSenderInput = z.infer<typeof createSenderSchema>;

export interface PublicSender {
  id: string;
  name: string;
  email: string;
  smtpHost: string;
  createdAt: Date;
  /** Ethereal web login lets you open the inbox of this sender (dev only). */
  etherealLogin: string | null;
}

export function toPublicSender(s: Sender): PublicSender {
  return {
    id: s.id,
    name: s.name,
    email: s.email,
    smtpHost: s.smtpHost,
    createdAt: s.createdAt,
    etherealLogin: s.smtpHost.includes('ethereal.email') ? 'https://ethereal.email/login' : null,
  };
}

export async function createSender(userId: string, input: CreateSenderInput): Promise<Sender> {
  let smtp: { host: string; port: number; secure: boolean; user: string; pass: string; email: string };
  if (input.smtp) {
    smtp = { ...input.smtp, email: input.smtp.email ?? input.smtp.user };
  } else {
    try {
      const account = await nodemailer.createTestAccount();
      smtp = {
        host: account.smtp.host,
        port: account.smtp.port,
        secure: account.smtp.secure,
        user: account.user,
        pass: account.pass,
        email: account.user,
      };
      logger.info({ userId, email: account.user }, 'Provisioned Ethereal sender');
    } catch (err) {
      logger.error({ err }, 'Could not provision Ethereal account');
      throw new HttpError(502, 'Could not create an Ethereal test account. Check network access to ethereal.email.');
    }
  }

  // Verify credentials before saving so a bad sender can't poison scheduled jobs.
  const transporter = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: { user: smtp.user, pass: smtp.pass },
  });
  try {
    await transporter.verify();
  } catch (err) {
    throw new HttpError(400, `SMTP verification failed: ${(err as Error).message}`);
  } finally {
    transporter.close();
  }

  try {
    return await prisma.sender.create({
      data: {
        userId,
        name: input.name,
        email: smtp.email,
        smtpHost: smtp.host,
        smtpPort: smtp.port,
        smtpUser: smtp.user,
        smtpPass: encrypt(smtp.pass),
        secure: smtp.secure,
      },
    });
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') throw new HttpError(409, 'A sender with this email already exists');
    throw err;
  }
}

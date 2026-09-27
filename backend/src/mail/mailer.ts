import nodemailer, { type Transporter } from 'nodemailer';
import type { Sender } from '@prisma/client';
import { decrypt } from '../lib/crypto';

export interface OutgoingEmail {
  to: string;
  subject: string;
  body: string;
  /** Deterministic Message-ID derived from the idempotency key. */
  messageId: string;
}

export interface SendResult {
  messageId: string;
  previewUrl: string | null;
}

export interface MailTransport {
  send(sender: Sender, email: OutgoingEmail): Promise<SendResult>;
}

/** Real SMTP (Ethereal in dev). One pooled transporter per sender, rebuilt if the sender changes. */
export class SmtpMailTransport implements MailTransport {
  private cache = new Map<string, { version: number; transporter: Transporter }>();

  private transporterFor(sender: Sender): Transporter {
    const version = sender.updatedAt.getTime();
    const cached = this.cache.get(sender.id);
    if (cached && cached.version === version) return cached.transporter;
    cached?.transporter.close();
    const transporter = nodemailer.createTransport({
      host: sender.smtpHost,
      port: sender.smtpPort,
      secure: sender.secure,
      pool: true,
      maxConnections: 3,
      auth: { user: sender.smtpUser, pass: decrypt(sender.smtpPass) },
    });
    this.cache.set(sender.id, { version, transporter });
    return transporter;
  }

  async send(sender: Sender, email: OutgoingEmail): Promise<SendResult> {
    const info = await this.transporterFor(sender).sendMail({
      from: { name: sender.name, address: sender.email },
      to: email.to,
      subject: email.subject,
      text: email.body,
      html: toHtml(email.body),
      messageId: email.messageId,
    });
    const preview = nodemailer.getTestMessageUrl(info);
    return { messageId: info.messageId, previewUrl: typeof preview === 'string' ? preview : null };
  }

  close() {
    for (const { transporter } of this.cache.values()) transporter.close();
    this.cache.clear();
  }
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function toHtml(body: string): string {
  return `<div style="font-family:sans-serif;font-size:14px;line-height:1.5">${escapeHtml(body).replace(/\n/g, '<br/>')}</div>`;
}

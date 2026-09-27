import { config } from '../config';
import { decrypt, encrypt } from '../lib/crypto';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';

const SLACK_SCOPES = ['incoming-webhook', 'chat:write'];

export function slackAuthorizeUrl(state: string): string {
  const url = new URL('https://slack.com/oauth/v2/authorize');
  url.searchParams.set('client_id', config.SLACK_CLIENT_ID ?? '');
  url.searchParams.set('scope', SLACK_SCOPES.join(','));
  url.searchParams.set('redirect_uri', config.slackRedirectUri);
  url.searchParams.set('state', state);
  return url.toString();
}

interface SlackOAuthResponse {
  ok: boolean;
  error?: string;
  access_token?: string;
  team?: { id: string; name: string };
  incoming_webhook?: { channel: string; channel_id: string; url: string };
}

/** Exchange the OAuth code (oauth.v2.access) and store/replace the user's connection. */
export async function completeSlackOAuth(userId: string, code: string): Promise<void> {
  const res = await fetch('https://slack.com/api/oauth.v2.access', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: config.SLACK_CLIENT_ID ?? '',
      client_secret: config.SLACK_CLIENT_SECRET ?? '',
      redirect_uri: config.slackRedirectUri,
    }),
  });
  const data = (await res.json()) as SlackOAuthResponse;
  if (!data.ok || !data.access_token || !data.team) {
    throw new Error(`Slack OAuth failed: ${data.error ?? res.status}`);
  }
  const values = {
    teamId: data.team.id,
    teamName: data.team.name,
    channelId: data.incoming_webhook?.channel_id ?? null,
    channelName: data.incoming_webhook?.channel ?? null,
    webhookUrl: data.incoming_webhook?.url ? encrypt(data.incoming_webhook.url) : null,
    accessToken: encrypt(data.access_token),
  };
  await prisma.slackConnection.upsert({ where: { userId }, create: { userId, ...values }, update: values });
  logger.info({ userId, team: data.team.name, channel: values.channelName }, 'Slack connected');
}

export async function disconnectSlack(userId: string): Promise<void> {
  const conn = await prisma.slackConnection.findUnique({ where: { userId } });
  if (!conn) return;
  // Best effort: revoke the token at Slack too.
  try {
    await fetch('https://slack.com/api/auth.revoke', {
      method: 'POST',
      headers: { Authorization: `Bearer ${decrypt(conn.accessToken)}` },
    });
  } catch (err) {
    logger.warn({ err }, 'Slack token revoke failed');
  }
  await prisma.slackConnection.delete({ where: { userId } });
}

export interface SlackMessage {
  text: string;
  blocks?: unknown[];
}

/**
 * Sends a message to the user's connected Slack. Connection is looked up on every call,
 * so connecting / disconnecting takes effect immediately without a redeploy.
 * Returns false (never throws) when Slack is not connected or the call fails.
 */
export async function notifyUser(userId: string, message: SlackMessage): Promise<boolean> {
  const conn = await prisma.slackConnection.findUnique({ where: { userId } });
  if (!conn) {
    logger.info({ userId }, 'Slack not connected; rate-limit notification skipped');
    return false;
  }
  try {
    if (conn.webhookUrl) {
      const res = await fetch(decrypt(conn.webhookUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(message),
      });
      if (!res.ok) throw new Error(`Slack webhook responded ${res.status}: ${await res.text()}`);
    } else if (conn.channelId) {
      const res = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${decrypt(conn.accessToken)}` },
        body: JSON.stringify({ channel: conn.channelId, ...message }),
      });
      const data = (await res.json()) as { ok: boolean; error?: string };
      if (!data.ok) throw new Error(`chat.postMessage failed: ${data.error}`);
    } else {
      logger.warn({ userId }, 'Slack connection has no channel/webhook');
      return false;
    }
    logger.info({ userId, team: conn.teamName, channel: conn.channelName }, 'Slack notification sent');
    return true;
  } catch (err) {
    logger.error({ err, userId }, 'Slack notification failed');
    return false;
  }
}

export function rateLimitMessage(p: {
  senderEmail: string;
  limit: number;
  windowStart: Date;
  nextSendAt: Date;
}): SlackMessage {
  const fmt = (d: Date) => d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  const text = `:warning: Hourly sending limit reached for ${p.senderEmail} (${p.limit}/hour). Remaining emails were rescheduled - next send at ${fmt(p.nextSendAt)}.`;
  return {
    text,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: 'Hourly send limit reached' } },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Sender:*\n${p.senderEmail}` },
          { type: 'mrkdwn', text: `*Limit:*\n${p.limit} emails / hour` },
          { type: 'mrkdwn', text: `*Window:*\n${fmt(p.windowStart)}` },
          { type: 'mrkdwn', text: `*Next send:*\n${fmt(p.nextSendAt)}` },
        ],
      },
      { type: 'context', elements: [{ type: 'mrkdwn', text: 'No emails were dropped - overflow was moved to the next available hour, in order.' }] },
    ],
  };
}

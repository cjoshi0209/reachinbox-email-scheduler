import { Client } from '@elastic/elasticsearch';
import type { EmailStatus } from '@prisma/client';
import { config } from '../config';
import { logger } from '../lib/logger';

export const es = new Client({ node: config.ELASTICSEARCH_URL, requestTimeout: 10_000 });
const index = config.ELASTICSEARCH_INDEX;

export interface EmailSearchDoc {
  id: string;
  userId: string;
  campaignId: string;
  senderId: string;
  senderEmail: string;
  recipient: string;
  subject: string;
  body: string;
  status: EmailStatus;
  scheduledAt: string;
  sentAt: string | null;
  failedAt: string | null;
  error: string | null;
  createdAt: string;
}

export interface IndexableEmail {
  id: string;
  userId: string;
  campaignId: string;
  senderId: string;
  recipient: string;
  subject: string;
  body: string;
  status: EmailStatus;
  scheduledAt: Date;
  sentAt: Date | null;
  failedAt: Date | null;
  error: string | null;
  createdAt: Date;
  sender: { email: string };
}

export function toDoc(e: IndexableEmail): EmailSearchDoc {
  return {
    id: e.id,
    userId: e.userId,
    campaignId: e.campaignId,
    senderId: e.senderId,
    senderEmail: e.sender.email,
    recipient: e.recipient,
    subject: e.subject,
    body: e.body,
    status: e.status,
    scheduledAt: e.scheduledAt.toISOString(),
    sentAt: e.sentAt?.toISOString() ?? null,
    failedAt: e.failedAt?.toISOString() ?? null,
    error: e.error,
    createdAt: e.createdAt.toISOString(),
  };
}

export async function ensureIndex(): Promise<void> {
  if (await es.indices.exists({ index })) return;
  try {
    await createIndex();
    logger.info({ index }, 'Created Elasticsearch index');
  } catch (err) {
    // API and worker start concurrently; losing the creation race is fine.
    if ((err as { body?: { error?: { type?: string } } }).body?.error?.type !== 'resource_already_exists_exception') throw err;
  }
}

async function createIndex() {
  await es.indices.create({
    index,
    settings: {
      analysis: {
        analyzer: {
          email_analyzer: { type: 'custom', tokenizer: 'uax_url_email', filter: ['lowercase'] },
        },
      },
    },
    mappings: {
      properties: {
        id: { type: 'keyword' },
        userId: { type: 'keyword' },
        campaignId: { type: 'keyword' },
        senderId: { type: 'keyword' },
        senderEmail: { type: 'keyword' },
        recipient: {
          type: 'text',
          analyzer: 'standard',
          fields: { keyword: { type: 'keyword' }, email: { type: 'text', analyzer: 'email_analyzer' } },
        },
        subject: { type: 'text', fields: { keyword: { type: 'keyword', ignore_above: 256 } } },
        body: { type: 'text' },
        status: { type: 'keyword' },
        scheduledAt: { type: 'date' },
        sentAt: { type: 'date' },
        failedAt: { type: 'date' },
        error: { type: 'text' },
        createdAt: { type: 'date' },
      },
    },
  });
}

/**
 * Index (upsert) full documents. Elasticsearch is a derived read model: failures are
 * logged and never block scheduling/sending. `npm run es:reindex` rebuilds it from Postgres.
 */
export async function indexEmails(rows: IndexableEmail[], opts: { refresh?: boolean } = {}): Promise<void> {
  if (rows.length === 0) return;
  try {
    for (let i = 0; i < rows.length; i += 1000) {
      const chunk = rows.slice(i, i + 1000);
      const res = await es.bulk({
        refresh: opts.refresh ? 'wait_for' : false,
        operations: chunk.flatMap((r) => [{ index: { _index: index, _id: r.id } }, toDoc(r)]),
      });
      if (res.errors) {
        const first = res.items.find((it) => it.index?.error)?.index?.error;
        logger.warn({ error: first }, 'Some emails failed to index');
      }
    }
  } catch (err) {
    logger.warn({ err, count: rows.length }, 'Elasticsearch indexing failed (Postgres remains source of truth)');
  }
}

export const indexEmail = (row: IndexableEmail) => indexEmails([row]);

export interface SearchParams {
  userId: string;
  q: string;
  status?: EmailStatus[];
  limit: number;
  offset: number;
}

/**
 * Email-shaped queries match recipients/senders exactly (the uax_url_email analyzer keeps
 * the address as one token). Anything else is full-text with typo tolerance only for
 * words of 5+ characters, so short tokens like "dame" don't fuzzy-match "tame"/"game".
 */
function textQuery(q: string) {
  if (/^\S+@\S+$/.test(q)) {
    return {
      bool: {
        should: [
          { term: { 'recipient.keyword': q.toLowerCase() } },
          { match: { 'recipient.email': q } },
          { term: { senderEmail: q.toLowerCase() } },
        ],
        minimum_should_match: 1,
      },
    };
  }
  return {
    multi_match: {
      query: q,
      fields: ['subject^3', 'recipient^2', 'recipient.email^2', 'body', 'senderEmail'],
      type: 'best_fields' as const,
      fuzziness: 'AUTO:5,8',
      operator: 'and' as const,
    },
  };
}

export async function searchEmails(p: SearchParams): Promise<{ total: number; ids: string[] }> {
  const res = await es.search<EmailSearchDoc>({
    index,
    from: p.offset,
    size: p.limit,
    track_total_hits: true,
    query: {
      bool: {
        filter: [{ term: { userId: p.userId } }, ...(p.status?.length ? [{ terms: { status: p.status } }] : [])],
        must: p.q ? [textQuery(p.q)] : [{ match_all: {} }],
      },
    },
    sort: p.q ? ['_score', { scheduledAt: 'desc' }] : [{ scheduledAt: 'desc' }],
    _source: false,
  });
  const total = typeof res.hits.total === 'number' ? res.hits.total : (res.hits.total?.value ?? 0);
  return { total, ids: res.hits.hits.map((h) => h._id).filter((id): id is string => Boolean(id)) };
}

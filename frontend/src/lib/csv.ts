// Pragmatic email pattern (the backend re-validates every address with Zod).
const EMAIL_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

export interface ParsedLeads {
  emails: string[];
  duplicates: number;
  /** Cells that contained an "@" but were not valid emails. */
  invalid: string[];
}

export const isEmail = (value: string) => EMAIL_RE.test(value.trim());

/**
 * Extracts email addresses from CSV / TXT content. Works with or without a header row,
 * any column position, and comma / semicolon / tab / newline separators.
 * Order of first appearance is preserved; duplicates are removed case-insensitively.
 */
export function parseLeads(text: string): ParsedLeads {
  const seen = new Set<string>();
  const emails: string[] = [];
  const invalid: string[] = [];
  let duplicates = 0;

  for (const raw of text.replace(/^﻿/, '').split(/[\r\n,;\t]+/)) {
    const cell = raw.trim().replace(/^["'<(]+|[">)']+$/g, '').trim();
    if (!cell) continue;
    // Support "Jane Doe <jane@x.com>" style cells.
    const angled = /<([^>]+)>/.exec(raw)?.[1]?.trim();
    const candidate = (angled ?? cell).toLowerCase();
    if (!candidate.includes('@')) continue;
    if (!isEmail(candidate)) {
      invalid.push(cell);
      continue;
    }
    if (seen.has(candidate)) {
      duplicates++;
      continue;
    }
    seen.add(candidate);
    emails.push(candidate);
  }
  return { emails, duplicates, invalid };
}

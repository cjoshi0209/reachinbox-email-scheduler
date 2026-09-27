import { describe, expect, it } from 'vitest';
import { isEmail, parseLeads } from './csv';

describe('parseLeads', () => {
  it('finds emails in any column of a CSV with a header row', () => {
    const csv = 'name,email,company\nJane,jane@acme.com,Acme\nBob,bob@globex.io,Globex\n';
    expect(parseLeads(csv)).toEqual({ emails: ['jane@acme.com', 'bob@globex.io'], duplicates: 0, invalid: [] });
  });

  it('dedupes case-insensitively and preserves first-seen order', () => {
    const r = parseLeads('b@x.com\na@x.com\nB@X.com\n');
    expect(r.emails).toEqual(['b@x.com', 'a@x.com']);
    expect(r.duplicates).toBe(1);
  });

  it('handles quotes, semicolons, tabs, CRLF, BOM and "Name <email>" cells', () => {
    const text = '﻿"a@x.com";b@x.com\tc@x.com\r\nJane Doe <jane@x.com>\r\n';
    expect(parseLeads(text).emails).toEqual(['a@x.com', 'b@x.com', 'c@x.com', 'jane@x.com']);
  });

  it('reports malformed addresses and ignores non-email cells', () => {
    const r = parseLeads('email\nok@x.com\nbroken@\n@nope.com\nhello\n42\n');
    expect(r.emails).toEqual(['ok@x.com']);
    expect(r.invalid).toEqual(['broken@', '@nope.com']);
  });

  it('returns nothing for an empty file', () => {
    expect(parseLeads('')).toEqual({ emails: [], duplicates: 0, invalid: [] });
  });

  it('parses 10k rows quickly', () => {
    const rows = Array.from({ length: 10_000 }, (_, i) => `Lead ${i},lead${i}@example.com`).join('\n');
    const t = performance.now();
    expect(parseLeads(rows).emails).toHaveLength(10_000);
    expect(performance.now() - t).toBeLessThan(500);
  });
});

describe('isEmail', () => {
  it.each(['a@b.co', 'first.last+tag@sub.domain.io'])('accepts %s', (e) => expect(isEmail(e)).toBe(true));
  it.each(['a@b', 'a b@c.com', 'a@@b.com', 'plain'])('rejects %s', (e) => expect(isEmail(e)).toBe(false));
});

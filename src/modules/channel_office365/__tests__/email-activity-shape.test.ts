/**
 * Unit tests for the shared O365 email shaping helpers (email-activity-shape.ts).
 *
 * These pure functions are the single source of truth for the participant / body / timestamp
 * conventions used by BOTH the live linker (crm-email-linker) and the retroactive backfill
 * (customer-activity-backfill, Fix #2). The tests pin down:
 *   - sender-included (Activity) vs sender-excluded (CustomerInteraction "DO") participant views
 *   - dedup + lowercasing of the match set
 *   - markdown-preferred body extraction with cap
 *   - lenient receivedAt parsing
 */

import {
  type EmailChannelPayload,
  nameFromEmail,
  collectParticipantEmails,
  buildEmailParticipants,
  participantsToJson,
  extractEmailBody,
  parseReceivedAt,
} from '../lib/email-activity-shape'

describe('nameFromEmail', () => {
  it('title-cases the local part across . _ - separators', () => {
    expect(nameFromEmail('piotr.kowalczyk@xentivo.pl')).toBe('Piotr Kowalczyk')
    expect(nameFromEmail('jan_nowak@x.pl')).toBe('Jan Nowak')
    expect(nameFromEmail('anna-maria@x.pl')).toBe('Anna Maria')
  })
  it('handles a separator-less local part and degenerate input', () => {
    expect(nameFromEmail('jira@neuca.pl')).toBe('Jira')
    expect(nameFromEmail('weird')).toBe('Weird')
  })
})

describe('collectParticipantEmails', () => {
  it('lowercases, dedupes and drops empties across from/to/cc', () => {
    const cp: EmailChannelPayload = {
      from: 'Boss@Acme.COM',
      to: ['a@x.pl', 'A@X.PL', ''],
      cc: ['b@x.pl', 'boss@acme.com'],
    }
    expect(collectParticipantEmails(cp)).toEqual(['boss@acme.com', 'a@x.pl', 'b@x.pl'])
  })
  it('tolerates missing arrays', () => {
    expect(collectParticipantEmails({ from: 'x@y.pl' })).toEqual(['x@y.pl'])
    expect(collectParticipantEmails({})).toEqual([])
  })
})

describe('buildEmailParticipants', () => {
  it('builds the all view (incl. sender) and recipients view (excl. sender)', () => {
    const cp: EmailChannelPayload = {
      from: 'sender@x.pl',
      fromName: 'The Sender',
      to: ['to1@x.pl'],
      cc: ['cc1@x.pl'],
    }
    const { all, recipients } = buildEmailParticipants(cp)
    expect(all).toEqual([
      { email: 'sender@x.pl', name: 'The Sender', status: 'sender' },
      { email: 'to1@x.pl', name: 'To1', status: 'recipient' },
      { email: 'cc1@x.pl', name: 'Cc1', status: 'cc' },
    ])
    expect(recipients).toEqual([
      { email: 'to1@x.pl', name: 'To1', status: 'recipient' },
      { email: 'cc1@x.pl', name: 'Cc1', status: 'cc' },
    ])
  })
  it('dedupes by email first-wins (sender beats a duplicate recipient)', () => {
    const cp: EmailChannelPayload = {
      from: 'dup@x.pl',
      to: ['DUP@x.pl', 'other@x.pl'],
    }
    const { all, recipients } = buildEmailParticipants(cp)
    expect(all.map((p) => p.status)).toEqual(['sender', 'recipient'])
    expect(all[0]).toEqual({ email: 'dup@x.pl', name: 'Dup', status: 'sender' })
    expect(recipients).toEqual([{ email: 'other@x.pl', name: 'Other', status: 'recipient' }])
  })
  it('returns empty views for an empty payload', () => {
    expect(buildEmailParticipants({})).toEqual({ all: [], recipients: [] })
  })
})

describe('participantsToJson', () => {
  it('returns null for an empty list and JSON for a non-empty one', () => {
    expect(participantsToJson([])).toBeNull()
    expect(participantsToJson([{ email: 'a@x.pl', name: 'A', status: 'recipient' }]))
      .toBe('[{"email":"a@x.pl","name":"A","status":"recipient"}]')
  })
})

describe('extractEmailBody', () => {
  it('prefers markdown, trimmed', () => {
    expect(extractEmailBody({ markdown: '  # Hi  ', text: 'plain' })).toBe('# Hi')
  })
  it('falls back to plain text when markdown is blank', () => {
    expect(extractEmailBody({ markdown: '   ', text: 'plain body' })).toBe('plain body')
  })
  it('returns null when both are empty/absent and caps long bodies', () => {
    expect(extractEmailBody({})).toBeNull()
    expect(extractEmailBody({ text: 'x'.repeat(20100) }, 20000)).toHaveLength(20000)
  })
})

describe('parseReceivedAt', () => {
  it('parses a valid ISO timestamp', () => {
    expect(parseReceivedAt({ receivedAt: '2026-06-26T10:00:00.000Z' })?.toISOString())
      .toBe('2026-06-26T10:00:00.000Z')
  })
  it('returns null for missing or invalid timestamps', () => {
    expect(parseReceivedAt({})).toBeNull()
    expect(parseReceivedAt({ receivedAt: 'not-a-date' })).toBeNull()
    expect(parseReceivedAt({ receivedAt: null })).toBeNull()
  })
})

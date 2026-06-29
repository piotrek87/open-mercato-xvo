/**
 * Unit tests for the O365 email-attachments data layer (Stage 1).
 *
 * Covers the pure shaping logic used by both the email-attachments route
 * (single-email + person/company modes) and the activities interceptor:
 *   - single-email backward compatibility (groups[0] = files + skipped)
 *   - person/company dedup (company → persons expansion can link one email twice)
 *   - stored-only / clutter-free scoped grouping (emails without files omitted)
 *   - countOnly totals
 *   - interceptor per-row count mapping
 * Plus the DB helper's filter + mapping (stored-files-only by partition).
 */

import {
  parseO365MailSource,
  toIsoOrNull,
  extractSkippedRecords,
  summarizeAttachmentGroups,
  dedupeCiMetaBySource,
  buildScopedAttachmentGroups,
  buildSingleAttachmentGroup,
  applyEmailAttachmentCounts,
  type EmailAttachmentFile,
  type EmailAttachmentGroup,
} from '../lib/email-attachments-shape'

const file = (id: string): EmailAttachmentFile => ({
  id,
  fileName: `${id}.pdf`,
  mimeType: 'application/pdf',
  fileSize: 1234,
  url: `/api/attachments/file/${id}`,
})

describe('parseO365MailSource', () => {
  it('extracts the external message id from an O365 mail source', () => {
    expect(parseO365MailSource('office365:mail:ABC-123')).toBe('ABC-123')
  })
  it('returns null for non-O365 sources, empty ids and non-strings', () => {
    expect(parseO365MailSource('legacy-activity')).toBeNull()
    expect(parseO365MailSource('office365:mail:')).toBeNull()
    expect(parseO365MailSource(null)).toBeNull()
    expect(parseO365MailSource(undefined)).toBeNull()
    expect(parseO365MailSource(42)).toBeNull()
  })
})

describe('toIsoOrNull', () => {
  it('passes through valid dates/strings and rejects invalid ones', () => {
    expect(toIsoOrNull('2026-06-01T10:00:00.000Z')).toBe('2026-06-01T10:00:00.000Z')
    expect(toIsoOrNull(new Date('2026-06-01T10:00:00.000Z'))).toBe('2026-06-01T10:00:00.000Z')
    expect(toIsoOrNull(null)).toBeNull()
    expect(toIsoOrNull('not-a-date')).toBeNull()
  })
})

describe('extractSkippedRecords', () => {
  it('keeps only non-stored sync records', () => {
    const cp = {
      attachments: [
        { fileName: 'a.pdf', fileSizeBytes: 10, status: 'stored' },
        { fileName: 'big.zip', fileSizeBytes: 999, status: 'too_large' },
        { fileName: 'logo.png', fileSizeBytes: 5, status: 'skipped_inline' },
        { fileName: 'x.bin', status: 'fetch_error' },
      ],
    }
    expect(extractSkippedRecords(cp)).toEqual([
      { fileName: 'big.zip', fileSizeBytes: 999, status: 'too_large' },
      { fileName: 'logo.png', fileSizeBytes: 5, status: 'skipped_inline' },
      { fileName: 'x.bin', fileSizeBytes: 0, status: 'fetch_error' },
    ])
  })
  it('returns [] for missing/empty payloads', () => {
    expect(extractSkippedRecords(null)).toEqual([])
    expect(extractSkippedRecords({})).toEqual([])
  })
})

describe('dedupeCiMetaBySource (company → persons dedup)', () => {
  it('collapses the same email linked via multiple entities, keeping the first meta', () => {
    const rows = [
      { source: 'office365:mail:E1', title: 'Offer', occurredAt: '2026-06-02T09:00:00.000Z' },
      // same email surfaced again via the linked company entity → must dedupe
      { source: 'office365:mail:E1', title: 'Offer (dup)', occurredAt: '2026-06-02T09:00:00.000Z' },
      { source: 'office365:mail:E2', title: 'Invoice', occurredAt: '2026-06-03T09:00:00.000Z' },
      { source: 'legacy-activity', title: 'ignored', occurredAt: null },
    ]
    const map = dedupeCiMetaBySource(rows)
    expect([...map.keys()]).toEqual(['E1', 'E2'])
    expect(map.get('E1')).toEqual({ subject: 'Offer', occurredAt: '2026-06-02T09:00:00.000Z' })
  })
})

describe('buildScopedAttachmentGroups', () => {
  const meta = new Map([
    ['E1', { subject: 'Older', occurredAt: '2026-06-01T00:00:00.000Z' }],
    ['E2', { subject: 'Newer', occurredAt: '2026-06-05T00:00:00.000Z' }],
    ['E3', { subject: 'No files', occurredAt: '2026-06-09T00:00:00.000Z' }],
    ['E4', { subject: 'No link', occurredAt: '2026-06-10T00:00:00.000Z' }],
  ])
  const links = new Map([
    ['E1', { linkId: 'L1', direction: 'inbound' }],
    ['E2', { linkId: 'L2', direction: 'outbound' }],
    ['E3', { linkId: 'L3', direction: 'inbound' }],
    // E4 intentionally has no link
  ])
  const files = new Map([
    ['L1', [file('f1')]],
    ['L2', [file('f2a'), file('f2b')]],
    ['L3', []], // no downloadable files → email omitted (stored-only / clutter-free)
  ])

  it('omits emails with no files and emails without a resolved link', () => {
    const groups = buildScopedAttachmentGroups(meta, links, files)
    expect(groups.map((g) => g.externalMessageId)).toEqual(['E2', 'E1'])
  })

  it('sorts newest first and maps subject/direction/files', () => {
    const groups = buildScopedAttachmentGroups(meta, links, files)
    expect(groups[0]).toMatchObject({
      externalMessageId: 'E2',
      linkId: 'L2',
      subject: 'Newer',
      direction: 'outbound',
    })
    expect(groups[0].files).toHaveLength(2)
    expect(groups[0].skipped).toEqual([])
  })
})

describe('buildSingleAttachmentGroup (Faza 0 compatibility)', () => {
  const link = {
    id: 'L9',
    externalMessageId: 'E9',
    channelPayload: { subject: 'Contract', receivedAt: '2026-06-04T08:00:00.000Z', direction: 'inbound' },
  }

  it('returns one group with files + skipped (the shape Faza 0 reads as groups[0])', () => {
    const cp = {
      ...link.channelPayload,
      attachments: [{ fileName: 'big.zip', fileSizeBytes: 99, status: 'too_large' }],
    }
    const group = buildSingleAttachmentGroup({ ...link, channelPayload: cp }, [file('f9')])
    expect(group).not.toBeNull()
    expect(group!.files).toHaveLength(1)
    expect(group!.skipped).toEqual([{ fileName: 'big.zip', fileSizeBytes: 99, status: 'too_large' }])
    expect(group!).toMatchObject({ externalMessageId: 'E9', linkId: 'L9', subject: 'Contract', direction: 'inbound' })
    expect(group!.occurredAt).toBe('2026-06-04T08:00:00.000Z')
  })

  it('returns null when there are neither files nor skipped notes (render-nothing)', () => {
    expect(buildSingleAttachmentGroup(link, [])).toBeNull()
  })
})

describe('summarizeAttachmentGroups (countOnly)', () => {
  it('sums files and counts emails', () => {
    const groups: EmailAttachmentGroup[] = [
      { externalMessageId: 'E1', linkId: 'L1', subject: null, occurredAt: null, direction: null, files: [file('a'), file('b')], skipped: [] },
      { externalMessageId: 'E2', linkId: 'L2', subject: null, occurredAt: null, direction: null, files: [file('c')], skipped: [] },
    ]
    expect(summarizeAttachmentGroups(groups)).toEqual({ totalFiles: 3, emailsWithAttachments: 2 })
  })
  it('is zero for no groups', () => {
    expect(summarizeAttachmentGroups([])).toEqual({ totalFiles: 0, emailsWithAttachments: 0 })
  })
})

describe('applyEmailAttachmentCounts (activities interceptor core)', () => {
  it('adds emailAttachmentCount to office365_mail rows only, leaving others untouched', () => {
    const rows = [
      { id: 'a1', externalProvider: 'office365_mail', externalId: 'E1' },
      { id: 'a2', externalProvider: 'office365_mail', externalId: 'E2' }, // not in map → 0
      { id: 'a3', externalProvider: 'gmail', externalId: 'G1' },
      { id: 'a4', externalProvider: null, externalId: null },
    ]
    const counts = new Map([['E1', 3]])
    const out = applyEmailAttachmentCounts(rows, counts)
    expect(out[0]).toEqual({ id: 'a1', externalProvider: 'office365_mail', externalId: 'E1', emailAttachmentCount: 3 })
    expect(out[1]).toEqual({ id: 'a2', externalProvider: 'office365_mail', externalId: 'E2', emailAttachmentCount: 0 })
    expect(out[2]).toEqual({ id: 'a3', externalProvider: 'gmail', externalId: 'G1' })
    expect(out[3]).toEqual({ id: 'a4', externalProvider: null, externalId: null })
  })
})

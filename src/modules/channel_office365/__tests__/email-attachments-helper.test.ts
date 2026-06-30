/**
 * Unit test for the DB helper `loadAttachmentsForLinkIds`. The core Attachment
 * entity is mocked so the test stays light (no MikroORM runtime). Verifies the
 * query is scoped to the stored-file partitions (inbound `email_attachments` +
 * outbound `email_outbound_attachments`, the latter re-homed to the link on send)
 * and that rows are grouped by linkId with download URLs.
 */

jest.mock('@open-mercato/core/modules/attachments/data/entities', () => ({
  Attachment: class Attachment {},
}))

import { loadAttachmentsForLinkIds } from '../lib/email-attachments'

describe('loadAttachmentsForLinkIds', () => {
  it('returns an empty map and does not query when linkIds is empty', async () => {
    const em = { find: jest.fn() }
    const map = await loadAttachmentsForLinkIds(em as any, [], { tenantId: 't1' })
    expect(map.size).toBe(0)
    expect(em.find).not.toHaveBeenCalled()
  })

  it('queries only the email_attachments partition and groups by linkId with download URLs', async () => {
    const rows = [
      { id: 'att1', recordId: 'L1', fileName: 'a.pdf', mimeType: 'application/pdf', fileSize: 10 },
      { id: 'att2', recordId: 'L1', fileName: 'b.pdf', mimeType: 'application/pdf', fileSize: 20 },
      { id: 'att3', recordId: 'L2', fileName: 'c.pdf', mimeType: 'application/pdf', fileSize: 30 },
    ]
    const em = { find: jest.fn().mockResolvedValue(rows) }
    const map = await loadAttachmentsForLinkIds(em as any, ['L1', 'L2'], { tenantId: 't1' })

    const filter = em.find.mock.calls[0][1]
    expect(filter).toMatchObject({
      entityId: 'communication_channels:message_channel_link',
      recordId: { $in: ['L1', 'L2'] },
      partitionCode: { $in: ['email_attachments', 'email_outbound_attachments'] },
      tenantId: 't1',
    })

    expect(map.get('L1')).toHaveLength(2)
    expect(map.get('L1')![0]).toEqual({
      id: 'att1',
      fileName: 'a.pdf',
      mimeType: 'application/pdf',
      fileSize: 10,
      url: '/api/attachments/file/att1',
    })
    expect(map.get('L2')).toHaveLength(1)
  })
})

import { isMailAttachmentRef, parseMailAttachmentRefs } from '../lib/types'
import type { MailAttachmentRef, MailAttachmentSource, ResolvedMailAttachment, ResolveScope } from '../lib/types'
import { checkAttachmentLimits, type MailAttachmentLimits } from '../lib/config'
import { createMailAttachmentResolver } from '../lib/resolver'

const SCOPE: ResolveScope = { tenantId: 't1', organizationId: 'o1', actorUserId: 'u1' }

function fileFor(id: string): ResolvedMailAttachment {
  return { fileName: `${id}.bin`, contentType: 'application/octet-stream', size: 10, read: async () => Buffer.from(id) }
}

describe('parseMailAttachmentRefs / isMailAttachmentRef', () => {
  it('accepts a well-formed attachment ref', () => {
    expect(isMailAttachmentRef({ kind: 'attachment', id: 'a' })).toBe(true)
  })
  it('rejects malformed values', () => {
    expect(isMailAttachmentRef(null)).toBe(false)
    expect(isMailAttachmentRef({ kind: 'attachment' })).toBe(false)
    expect(isMailAttachmentRef({ kind: 'other', id: 'a' })).toBe(false)
    expect(isMailAttachmentRef({ kind: 'attachment', id: '' })).toBe(false)
  })
  it('parses arrays, dropping invalid entries; non-arrays → []', () => {
    expect(parseMailAttachmentRefs([{ kind: 'attachment', id: 'a' }, { bad: 1 }, { kind: 'attachment', id: 'b' }]))
      .toEqual([{ kind: 'attachment', id: 'a' }, { kind: 'attachment', id: 'b' }])
    expect(parseMailAttachmentRefs(undefined)).toEqual([])
    expect(parseMailAttachmentRefs('nope')).toEqual([])
  })
})

describe('checkAttachmentLimits', () => {
  const limits: MailAttachmentLimits = { maxFiles: 2, maxFileBytes: 100, maxTotalBytes: 150 }
  it('passes within limits', () => {
    expect(checkAttachmentLimits([{ size: 50 }, { size: 50 }], limits)).toBeNull()
  })
  it('flags too many files', () => {
    expect(checkAttachmentLimits([{ size: 1 }, { size: 1 }, { size: 1 }], limits)).toEqual({ code: 'too_many_files', max: 2, actual: 3 })
  })
  it('flags a single file too large (with name)', () => {
    expect(checkAttachmentLimits([{ size: 200, fileName: 'big.pdf' }], limits)).toEqual({ code: 'file_too_large', max: 100, actual: 200, fileName: 'big.pdf' })
  })
  it('flags combined total too large', () => {
    expect(checkAttachmentLimits([{ size: 90 }, { size: 90 }], limits)).toEqual({ code: 'total_too_large', max: 150, actual: 180 })
  })
})

describe('createMailAttachmentResolver', () => {
  const attachmentSource: MailAttachmentSource = {
    kind: 'attachment',
    resolve: async (refs: MailAttachmentRef[]) => refs.map((r) => fileFor(r.id)),
  }

  it('returns [] for empty refs without touching sources', async () => {
    const resolver = createMailAttachmentResolver([attachmentSource])
    expect(await resolver.resolve([], SCOPE)).toEqual([])
  })

  it('resolves refs preserving original order', async () => {
    const resolver = createMailAttachmentResolver([attachmentSource])
    const out = await resolver.resolve(
      [{ kind: 'attachment', id: 'x' }, { kind: 'attachment', id: 'y' }, { kind: 'attachment', id: 'z' }],
      SCOPE,
    )
    expect(out.map((f) => f.fileName)).toEqual(['x.bin', 'y.bin', 'z.bin'])
  })

  it('fails closed on an unregistered kind', async () => {
    const resolver = createMailAttachmentResolver([attachmentSource])
    await expect(resolver.resolve([{ kind: 'ghost' } as unknown as MailAttachmentRef], SCOPE)).rejects.toThrow(/no source registered/)
  })

  it('fails closed when a source returns fewer files than refs', async () => {
    const shortSource: MailAttachmentSource = { kind: 'attachment', resolve: async () => [] }
    const resolver = createMailAttachmentResolver([shortSource])
    await expect(resolver.resolve([{ kind: 'attachment', id: 'x' }], SCOPE)).rejects.toThrow(/resolved 0\/1/)
  })
})

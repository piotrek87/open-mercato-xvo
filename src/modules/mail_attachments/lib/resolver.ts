/**
 * Provider-agnostic resolver façade. Groups a mixed batch of refs by `kind`, delegates each group
 * to its registered `MailAttachmentSource`, and reassembles the results in the ORIGINAL ref order
 * (so the adapter attaches files in the order the user added them). Fails closed: an unknown kind
 * or a short count from a source throws rather than silently dropping attachments.
 */

import type {
  MailAttachmentKind,
  MailAttachmentRef,
  MailAttachmentResolver,
  MailAttachmentSource,
  ResolvedMailAttachment,
  ResolveScope,
} from './types'

export function createMailAttachmentResolver(sources: MailAttachmentSource[]): MailAttachmentResolver {
  const byKind = new Map<MailAttachmentKind, MailAttachmentSource>(sources.map((s) => [s.kind, s]))

  return {
    async resolve(refs: MailAttachmentRef[], scope: ResolveScope): Promise<ResolvedMailAttachment[]> {
      if (!refs || refs.length === 0) return []

      const indicesByKind = new Map<MailAttachmentKind, number[]>()
      refs.forEach((ref, index) => {
        const arr = indicesByKind.get(ref.kind) ?? []
        arr.push(index)
        indicesByKind.set(ref.kind, arr)
      })

      const result: ResolvedMailAttachment[] = new Array(refs.length)
      for (const [kind, indices] of indicesByKind) {
        const source = byKind.get(kind)
        if (!source) throw new Error(`[mail_attachments] no source registered for kind: ${kind}`)
        const subRefs = indices.map((i) => refs[i])
        const resolved = await source.resolve(subRefs, scope)
        if (resolved.length !== subRefs.length) {
          throw new Error(`[mail_attachments] source '${kind}' resolved ${resolved.length}/${subRefs.length} attachments`)
        }
        indices.forEach((refIndex, j) => {
          result[refIndex] = resolved[j]
        })
      }
      return result
    },
  }
}

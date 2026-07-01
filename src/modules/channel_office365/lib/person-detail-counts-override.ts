/**
 * Wrapper override of `GET /api/customers/people/[id]`.
 *
 * WHY: the core person-detail endpoint computes `counts.activities` (the "Aktywności" tab badge)
 * as a raw `em.count(CustomerInteraction, { interactionType != 'task', ...visibilityFilter })` that
 * does NOT dedup the O365 "E-maile"-tab rows. Each synced O365 email produces TWO CustomerInteraction
 * rows — a source-CI (external_message_id NULL → the "Aktywności" timeline) and an extMsg-CI
 * (channel_provider_key='office365_mail', external_message_id NOT NULL → the threaded "E-maile" tab).
 * For the mailbox owner (who can see the private extMsg-CI), the badge double-counts every O365 email
 * (e.g. 14) while the timeline list + its /counts endpoint — which DO dedup — show 7.
 *
 * FIX: call the core handler, then recompute `counts.activities` / `counts.interactions` from
 * `getInteractionCounts` — the SAME deduped logic the timeline uses — so the badge always equals the
 * list. Manual activities (call/note/meeting/manual email) and synced source-CI stay counted; only
 * the extMsg-CI duplicates are excluded (see the dedup predicate in interactions-get-override). Fully
 * fail-safe: any error falls back to the core numbers so the detail page never breaks.
 *
 * Company detail is intentionally NOT wrapped: companies never receive extMsg-CI (the E-maile tab is
 * person-centric), so their badge is already correct — and getInteractionCounts would expand a
 * company to its linked persons, changing the company count's meaning.
 */
import { getInteractionCounts } from './interactions-get-override'

// Deep import into core (valid at runtime; bracket subpath resolves against dist).
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — untyped deep import of a core route module
const loadCoreRoute = () => import('@open-mercato/core/modules/customers/api/people/[id]/route')

function extractPersonId(rawUrl: string): string {
  // Match the id segment independent of the `/api` prefix — in an override handler req.url's
  // pathname may or may not carry it (mirrors channel-delete-guard). Excludes query/hash.
  const match = new URL(rawUrl).pathname.match(/\/people\/([^/?#]+)/)
  return match ? decodeURIComponent(match[1]) : ''
}

export async function GET(req: Request): Promise<Response> {
  const core = (await loadCoreRoute()) as {
    GET: (req: Request, ctx: { params: { id: string } }) => Promise<Response>
  }
  const id = extractPersonId(req.url)
  // Pass params as a PLAIN object: the core handler reads `ctx.params?.id` synchronously (not
  // awaited), so a Promise would yield `undefined` → "Invalid person id". A plain object also
  // satisfies `await ctx.params` if a future core version awaits it.
  const res = await core.GET(req, { params: { id } })
  if (!res.ok) return res

  let body: unknown
  try {
    body = await res.clone().json()
  } catch {
    return res
  }

  const counts = (body as { counts?: Record<string, unknown> } | null)?.counts
  if (!counts || typeof counts.activities !== 'number') return res

  try {
    const origin = new URL(req.url).origin
    const countsReq = new Request(
      `${origin}/api/customers/interactions/counts?entityId=${encodeURIComponent(id)}`,
      { headers: req.headers },
    )
    const countsRes = await getInteractionCounts(countsReq)
    if (countsRes.ok) {
      const parsed = (await countsRes.json()) as { result?: { total?: number; task?: number } }
      const result = parsed?.result
      if (result && typeof result.total === 'number') {
        const task = typeof result.task === 'number' ? result.task : 0
        counts.activities = Math.max(0, result.total - task)
        counts.interactions = result.total
      }
    }
  } catch {
    // Non-fatal: keep the core counts rather than break the detail page.
  }

  return Response.json(body, { status: res.status })
}

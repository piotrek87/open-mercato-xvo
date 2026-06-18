/**
 * Minimal Microsoft Graph API client for Calendar events.
 * Uses raw fetch — no SDK dependency.
 * Reference: https://learn.microsoft.com/en-us/graph/api/event-delta
 */

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0'
const DEFAULT_TIMEOUT_MS = 30_000
const CALENDAR_VIEW_WINDOW_DAYS = 90

export class GraphApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'GraphApiError'
  }
}

export interface GraphCalendarEvent {
  id: string
  subject: string
  bodyPreview?: string
  /** Version identifier — used for conflict detection (Sprint 8A) */
  changeKey?: string
  start: { dateTime: string; timeZone: string }
  end: { dateTime: string; timeZone: string }
  isAllDay?: boolean
  location?: { displayName?: string }
  attendees?: Array<{
    emailAddress: { address: string; name?: string }
    status: { response: string }
    type?: string
  }>
  organizer?: { emailAddress: { address: string; name?: string } }
  isCancelled?: boolean
  recurrence?: unknown
  seriesMasterId?: string
  type?: string
  webLink?: string
  lastModifiedDateTime?: string
  // Teams / online meeting fields (added Sprint 5 P2)
  isOnlineMeeting?: boolean
  /** 'teamsForBusiness' | 'skypeForBusiness' | 'skypeForConsumer' | 'unknown' */
  onlineMeetingProvider?: string
  /** Deprecated by MS but reliable simple-string join URL — works on delta endpoint */
  onlineMeetingUrl?: string | null
}

export interface GraphEventPayload {
  subject: string
  body?: { contentType: 'text' | 'HTML'; content: string }
  start: { dateTime: string; timeZone: string }
  end: { dateTime: string; timeZone: string }
  location?: { displayName: string }
  attendees?: Array<{
    emailAddress: { address: string; name?: string }
    type: 'required' | 'optional'
  }>
  isOnlineMeeting?: boolean
}

export interface GraphEventResponse {
  id: string
  changeKey: string
}

async function graphMutate(
  method: 'POST' | 'PATCH' | 'DELETE',
  url: string,
  accessToken: string,
  body?: unknown,
  sendUpdates?: 'all' | 'none' | 'modified',
): Promise<unknown> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS)
  const fullUrl = sendUpdates ? `${url}?$sendUpdates=${sendUpdates}` : url
  try {
    const res = await fetch(fullUrl, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    })
    if (!res.ok) {
      let detail = ''
      try {
        const errBody = (await res.json()) as { error?: { message?: string } }
        detail = errBody?.error?.message ?? ''
      } catch { /* ignore */ }
      throw new GraphApiError(res.status, `Graph API ${res.status}: ${detail || res.statusText}`)
    }
    if (method === 'DELETE') return null
    return await res.json()
  } finally {
    clearTimeout(timeout)
  }
}

/** POST /me/events — create a calendar event. Returns id + changeKey. */
export async function createCalendarEvent(
  accessToken: string,
  payload: GraphEventPayload,
): Promise<GraphEventResponse> {
  const res = await graphMutate('POST', `${GRAPH_BASE}/me/events`, accessToken, payload, 'all')
  return res as GraphEventResponse
}

/** PATCH /me/events/{id} — update existing event. Returns updated changeKey. */
export async function updateCalendarEvent(
  accessToken: string,
  eventId: string,
  payload: Partial<GraphEventPayload>,
): Promise<GraphEventResponse> {
  const res = await graphMutate('PATCH', `${GRAPH_BASE}/me/events/${eventId}`, accessToken, payload, 'none')
  return res as GraphEventResponse
}

/** DELETE /me/events/{id} — delete event. Sends cancellation to attendees. */
export async function deleteCalendarEvent(
  accessToken: string,
  eventId: string,
): Promise<void> {
  await graphMutate('DELETE', `${GRAPH_BASE}/me/events/${eventId}`, accessToken, undefined, 'all')
}

/** GET /me/events/{id}?$select=id,changeKey — fetch current changeKey for conflict check. */
export async function getCalendarEventChangeKey(
  accessToken: string,
  eventId: string,
): Promise<string | null> {
  try {
    const res = await graphFetch(
      `${GRAPH_BASE}/me/events/${eventId}?$select=id,changeKey`,
      accessToken,
    ) as { changeKey?: string }
    return res.changeKey ?? null
  } catch (err) {
    if (err instanceof GraphApiError && err.status === 404) return null
    throw err
  }
}

export interface CalendarDeltaPage {
  events: GraphCalendarEvent[]
  /** If set, use this URL for the next page of this batch */
  nextLink?: string
  /** If set, use this URL as the cursor for future delta polls */
  deltaLink?: string
}

async function graphFetch(url: string, accessToken: string): Promise<unknown> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        Prefer: 'odata.maxpagesize=100',
      },
      signal: controller.signal,
    })
    if (!res.ok) {
      let detail = ''
      try {
        const body = (await res.json()) as { error?: { message?: string } }
        detail = body?.error?.message ?? ''
      } catch {
        /* ignore */
      }
      throw new GraphApiError(
        res.status,
        `Graph API ${res.status}: ${detail || res.statusText}`,
      )
    }
    return await res.json()
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Fetch one page from the Graph Calendar Delta API.
 * On first call, pass `deltaToken = undefined` to bootstrap with a date window.
 * On subsequent calls, pass the `deltaLink` from the previous page as `deltaToken`.
 */
export async function fetchCalendarDeltaPage(
  accessToken: string,
  deltaToken?: string,
  syncFromDate?: Date,
): Promise<CalendarDeltaPage> {
  let url: string
  if (deltaToken) {
    // Resume from cursor — the deltaLink already contains all parameters
    url = deltaToken
  } else {
    // Bootstrap: use user-configured syncFromDate or fallback to now-7d
    const now = new Date()
    const start = syncFromDate ?? new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
    const end = new Date(now.getTime() + CALENDAR_VIEW_WINDOW_DAYS * 24 * 60 * 60 * 1000)
    const startIso = start.toISOString().replace(/\.\d{3}Z$/, 'Z')
    const endIso = end.toISOString().replace(/\.\d{3}Z$/, 'Z')
    url = `${GRAPH_BASE}/me/calendarView/delta?startdatetime=${startIso}&enddatetime=${endIso}&$select=id,subject,bodyPreview,start,end,isAllDay,location,attendees,organizer,isCancelled,recurrence,seriesMasterId,type,webLink,lastModifiedDateTime,isOnlineMeeting,onlineMeetingProvider,onlineMeetingUrl`
  }

  const raw = (await graphFetch(url, accessToken)) as {
    value?: GraphCalendarEvent[]
    '@odata.nextLink'?: string
    '@odata.deltaLink'?: string
  }

  return {
    events: raw.value ?? [],
    nextLink: raw['@odata.nextLink'],
    deltaLink: raw['@odata.deltaLink'],
  }
}

/**
 * Drain all pages from the Graph Calendar Delta API.
 * Returns all events and the final deltaLink (cursor for next poll).
 */
export async function drainCalendarDelta(
  accessToken: string,
  deltaToken?: string,
  syncFromDate?: Date,
): Promise<{ events: GraphCalendarEvent[]; nextDeltaToken?: string }> {
  const events: GraphCalendarEvent[] = []
  let nextDeltaToken: string | undefined
  let currentToken = deltaToken
  let maxPages = 50

  while (maxPages-- > 0) {
    const page = await fetchCalendarDeltaPage(accessToken, currentToken, syncFromDate)
    events.push(...page.events)

    if (page.deltaLink) {
      nextDeltaToken = page.deltaLink
      break
    }
    if (page.nextLink) {
      currentToken = page.nextLink
    } else {
      break
    }
  }

  return { events, nextDeltaToken }
}

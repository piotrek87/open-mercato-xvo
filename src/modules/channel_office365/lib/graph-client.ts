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
): Promise<CalendarDeltaPage> {
  let url: string
  if (deltaToken) {
    // Resume from cursor — the deltaLink already contains all parameters
    url = deltaToken
  } else {
    // Bootstrap: request events from now-7d to now+WINDOW_DAYS
    const now = new Date()
    const start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
    const end = new Date(now.getTime() + CALENDAR_VIEW_WINDOW_DAYS * 24 * 60 * 60 * 1000)
    const startIso = start.toISOString().replace(/\.\d{3}Z$/, 'Z')
    const endIso = end.toISOString().replace(/\.\d{3}Z$/, 'Z')
    url = `${GRAPH_BASE}/me/calendarView/delta?startdatetime=${startIso}&enddatetime=${endIso}&$top=100&$select=id,subject,bodyPreview,start,end,isAllDay,location,attendees,organizer,isCancelled,recurrence,seriesMasterId,type,webLink,lastModifiedDateTime`
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
): Promise<{ events: GraphCalendarEvent[]; nextDeltaToken?: string }> {
  const events: GraphCalendarEvent[] = []
  let nextDeltaToken: string | undefined
  let currentToken = deltaToken
  let maxPages = 50

  while (maxPages-- > 0) {
    const page = await fetchCalendarDeltaPage(accessToken, currentToken)
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

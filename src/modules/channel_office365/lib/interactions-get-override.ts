import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import { sql } from 'kysely'
import { CrudHttpError, isCrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { loadCustomFieldValues } from '@open-mercato/shared/lib/crud/custom-fields'
import { normalizeCustomFieldResponse } from '@open-mercato/shared/lib/custom-fields/normalize'
import { applyResponseEnrichers } from '@open-mercato/shared/lib/crud/enricher-runner'
import type { EnricherContext } from '@open-mercato/shared/lib/crud/response-enricher'
import { findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { escapeLikePattern } from '@open-mercato/shared/lib/db/escapeLikePattern'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { resolveOrganizationScopeForRequest } from '@open-mercato/core/modules/directory/utils/organizationScope'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { CustomerDeal, CustomerInteraction } from '@open-mercato/core/modules/customers/data/entities'
import { User } from '@open-mercato/core/modules/auth/data/entities'
import { CUSTOMER_INTERACTION_ENTITY_ID } from '@open-mercato/core/modules/customers/lib/interactionCompatibility'
import { applyEmailVisibilityFilter } from '@open-mercato/core/modules/customers/lib/visibilityFilter'

// ─── Schemas (mirrors core interactions route) ───────────────────────────────

const interactionSortFieldSchema = z.enum([
  'scheduledAt',
  'occurredAt',
  'createdAt',
  'updatedAt',
  'status',
  'priority',
  'interactionType',
  'title',
])

const listSchema = z
  .object({
    limit: z.coerce.number().min(1).max(100).default(25),
    cursor: z.string().optional(),
    entityId: z.string().uuid().optional(),
    dealId: z.string().uuid().optional(),
    status: z.string().optional(),
    interactionType: z.string().optional(),
    type: z.string().optional(),
    excludeInteractionType: z.string().optional(),
    search: z.string().trim().min(1).optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    pinned: z.enum(['true', 'false']).optional(),
    sortField: interactionSortFieldSchema.optional(),
    sortDir: z.enum(['asc', 'desc']).optional(),
  })
  .passthrough()

const interactionSortConfig = {
  scheduledAt: { column: 'scheduled_at', type: 'date' as const, defaultDir: 'asc' as const },
  occurredAt: { column: 'occurred_at', type: 'date' as const, defaultDir: 'desc' as const },
  createdAt: { column: 'created_at', type: 'date' as const, defaultDir: 'desc' as const },
  updatedAt: { column: 'updated_at', type: 'date' as const, defaultDir: 'desc' as const },
  status: { column: 'status', type: 'text' as const, defaultDir: 'asc' as const },
  priority: { column: 'priority', type: 'number' as const, defaultDir: 'desc' as const },
  interactionType: { column: 'interaction_type', type: 'text' as const, defaultDir: 'asc' as const },
  title: { column: 'title', type: 'text' as const, defaultDir: 'asc' as const },
} as const

// ─── Cursor helpers (mirrors core) ───────────────────────────────────────────

type CursorPayload = { id: string; sortValue: string | number | null }

const cursorSchema = z.object({
  id: z.string().uuid(),
  sortValue: z.union([z.string(), z.number(), z.null()]),
})

function toIsoString(value: unknown): string | null {
  if (value == null) return null
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString()
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed.length) return null
    const parsed = new Date(trimmed)
    return Number.isNaN(parsed.getTime()) ? trimmed : parsed.toISOString()
  }
  return null
}

function normalizeCursorValue(
  value: string | number | Date | null,
  type: 'date' | 'number' | 'text',
): string | number | null {
  if (value == null) return null
  if (type === 'number') {
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string') {
      const parsed = Number(value)
      return Number.isNaN(parsed) ? null : parsed
    }
    return null
  }
  if (type === 'date') return toIsoString(value)
  if (typeof value === 'string') return value
  if (value instanceof Date) return value.toISOString()
  return String(value)
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
}

function decodeCursor(token: string | undefined, type: 'date' | 'number' | 'text'): CursorPayload | null {
  if (!token) return null
  try {
    const decoded = Buffer.from(token, 'base64').toString('utf8')
    const parsed = cursorSchema.parse(JSON.parse(decoded))
    return { id: parsed.id, sortValue: normalizeCursorValue(parsed.sortValue, type) }
  } catch {
    return null
  }
}

function buildSortSql(sortField: keyof typeof interactionSortConfig, sortDir: 'asc' | 'desc'): string {
  const config = interactionSortConfig[sortField]
  if (config.type === 'date') {
    const sentinel = sortDir === 'asc'
      ? "timestamp with time zone '9999-12-31T23:59:59.999Z'"
      : "timestamp with time zone '0001-01-01T00:00:00.000Z'"
    return `coalesce(${config.column}, ${sentinel})`
  }
  if (config.type === 'number') {
    const sentinel = sortDir === 'asc' ? '2147483647' : '-2147483648'
    return `coalesce(${config.column}, ${sentinel})`
  }
  const sentinel = sortDir === 'asc' ? "'~~~~~~~~~~'" : "''"
  return `coalesce(${config.column}, ${sentinel})`
}

// ─── RBAC / enricher helpers (mirrors core) ──────────────────────────────────

type RbacServiceLike = {
  getGrantedFeatures?: (userId: string, input: { tenantId: string | null; organizationId: string | null }) => Promise<string[]>
}

async function resolveUserFeatures(
  container: { resolve: (name: string) => unknown },
  userId: string,
  tenantId: string | null,
  organizationId: string | null,
): Promise<string[] | undefined> {
  try {
    const rbac = container.resolve('rbacService') as RbacServiceLike | undefined
    if (!rbac?.getGrantedFeatures) return undefined
    return await rbac.getGrantedFeatures(userId, { tenantId, organizationId })
  } catch {
    return undefined
  }
}

async function buildEnricherContext(
  container: { resolve: (name: string) => unknown },
  auth: NonNullable<Awaited<ReturnType<typeof getAuthFromRequest>>>,
  organizationId: string | null,
  precomputedUserFeatures?: { userId: string; features: string[] | undefined },
): Promise<EnricherContext> {
  const userId =
    (typeof auth.sub === 'string' && auth.sub.trim().length > 0
      ? auth.sub
      : typeof auth.userId === 'string' && auth.userId.trim().length > 0
        ? auth.userId
        : typeof auth.keyId === 'string' && auth.keyId.trim().length > 0
          ? auth.keyId
          : 'system')

  const userFeatures =
    precomputedUserFeatures && precomputedUserFeatures.userId === userId
      ? precomputedUserFeatures.features
      : await resolveUserFeatures(container, userId, auth.tenantId ?? null, organizationId)

  return {
    organizationId: organizationId ?? '',
    tenantId: auth.tenantId ?? '',
    userId,
    em: container.resolve('em'),
    container,
    userFeatures,
  }
}

// ─── D365-style company expansion ────────────────────────────────────────────
// When the requested entityId belongs to a company, expand the filter to include
// all persons currently linked to that company via customer_person_company_links.
// This mirrors D365 behaviour: linking/unlinking a person immediately changes
// which CIs appear on the company's activities tab, with no re-sync required.

async function resolveExpandedEntityIds(
  db: any,
  entityId: string,
  tenantId: string,
): Promise<string[]> {
  const entityRow = await (db
    .selectFrom('customer_entities')
    .select(['kind'])
    .where('id', '=', entityId)
    .where('tenant_id', '=', tenantId)
    .where('deleted_at', 'is', null)
    .executeTakeFirst() as Promise<{ kind: string } | undefined>)

  if (!entityRow || entityRow.kind !== 'company') {
    return [entityId]
  }

  const linkRows = await (db
    .selectFrom('customer_person_company_links')
    .select(['person_entity_id'])
    .where('company_entity_id', '=', entityId)
    .where('tenant_id', '=', tenantId)
    .where('deleted_at', 'is', null)
    .execute() as Promise<Array<{ person_entity_id: string }>>)

  return [entityId, ...linkRows.map((r) => r.person_entity_id)]
}

// ─── GET handler ─────────────────────────────────────────────────────────────

type InteractionListRow = {
  id: string
  entity_id: string
  deal_id: string | null
  interaction_type: string
  title: string | null
  body: string | null
  status: string
  scheduled_at: Date | null
  occurred_at: Date | null
  priority: number | null
  author_user_id: string | null
  owner_user_id: string | null
  appearance_icon: string | null
  appearance_color: string | null
  source: string | null
  duration_minutes: number | null
  location: string | null
  all_day: boolean | null
  recurrence_rule: string | null
  recurrence_end: Date | null
  participants: Array<{ userId: string; name?: string; email?: string; status?: string }> | null
  reminder_minutes: number | null
  visibility: string | null
  linked_entities: Array<{ id: string; type: string; label: string }> | null
  guest_permissions: { canInviteOthers?: boolean; canModify?: boolean; canSeeList?: boolean } | null
  pinned: boolean
  organization_id: string
  tenant_id: string
  created_at: Date
  updated_at: Date
  __sort_value: string | number | Date | null
}

export async function GET(req: Request) {
  try {
    const queryUrl = new URL(req.url)
    const query = listSchema.parse(Object.fromEntries(queryUrl.searchParams))
    const container = await createRequestContainer()
    const auth = await getAuthFromRequest(req)
    const { translate } = await resolveTranslations()

    if (!auth || !auth.tenantId) {
      throw new CrudHttpError(401, {
        error: translate('customers.errors.unauthorized', 'Unauthorized'),
      })
    }

    const scope = await resolveOrganizationScopeForRequest({ container, auth, request: req })
    const organizationIds = Array.isArray(scope?.filterIds) && scope.filterIds.length > 0
      ? scope.filterIds
      : auth.orgId
        ? [auth.orgId]
        : []
    const selectedOrganizationId = scope?.selectedId ?? auth.orgId ?? organizationIds[0] ?? null
    const em = (container.resolve('em') as EntityManager).fork()
    const db = em.getKysely<any>() as any

    const requestedSortField = query.sortField ?? 'scheduledAt'
    const sortConfig = interactionSortConfig[requestedSortField]
    const sortDir = query.sortDir ?? sortConfig.defaultDir
    const sortSql = buildSortSql(requestedSortField, sortDir)
    const cursor = decodeCursor(query.cursor, sortConfig.type)
    if (query.cursor && !cursor) {
      throw new CrudHttpError(400, {
        error: translate('customers.interactions.cursor.invalid', 'Invalid cursor'),
      })
    }

    let rowsQuery = db
      .selectFrom('customer_interactions')
      .select([
        'id',
        'entity_id',
        'deal_id',
        'interaction_type',
        'title',
        'body',
        'status',
        'scheduled_at',
        'occurred_at',
        'priority',
        'author_user_id',
        'owner_user_id',
        'appearance_icon',
        'appearance_color',
        'source',
        'duration_minutes',
        'location',
        'all_day',
        'recurrence_rule',
        'recurrence_end',
        'participants',
        'reminder_minutes',
        'visibility',
        'linked_entities',
        'guest_permissions',
        'pinned',
        'organization_id',
        'tenant_id',
        'created_at',
        'updated_at',
        sql`${sql.raw(sortSql)}`.as('__sort_value'),
      ])
      .where('deleted_at', 'is', null)
      .where('tenant_id', '=', auth.tenantId)
      .limit(query.limit + 1)

    if (organizationIds.length > 0) {
      rowsQuery = rowsQuery.where('organization_id', 'in', organizationIds)
    }

    // Sprint 7D: D365-style entity expansion.
    // When entityId refers to a company, expand to include linked persons so their
    // O365 CIs appear dynamically based on current person-company relationships.
    if (query.entityId) {
      const entityIds = await resolveExpandedEntityIds(db, query.entityId, auth.tenantId)
      if (entityIds.length === 1) {
        rowsQuery = rowsQuery.where('entity_id', '=', entityIds[0])
      } else {
        rowsQuery = rowsQuery.where('entity_id', 'in', entityIds)
      }
    }

    // Sprint 7D: Strip dealId when entityId is also present.
    // O365 CIs have deal_id=NULL, so applying both filters (AND) hides them.
    // Dropping dealId makes the list consistent with tab counts (which only use entityId).
    if (query.dealId && !query.entityId) {
      rowsQuery = rowsQuery.where('deal_id', '=', query.dealId)
    }

    if (query.status) rowsQuery = rowsQuery.where('status', '=', query.status)
    if (query.interactionType) rowsQuery = rowsQuery.where('interaction_type', '=', query.interactionType)
    if (query.type) {
      const types = query.type.split(',').map((t) => t.trim()).filter(Boolean)
      if (types.length > 0) rowsQuery = rowsQuery.where('interaction_type', 'in', types)
    }
    if (query.pinned === 'true') {
      rowsQuery = rowsQuery.where('pinned', '=', true)
    } else if (query.pinned === 'false') {
      rowsQuery = rowsQuery.where('pinned', '=', false)
    }
    if (query.excludeInteractionType) rowsQuery = rowsQuery.where('interaction_type', '!=', query.excludeInteractionType)
    if (query.search) {
      const searchTerm = `%${escapeLikePattern(query.search)}%`
      rowsQuery = rowsQuery.where(sql<boolean>`coalesce(title, '') ilike ${searchTerm} or coalesce(body, '') ilike ${searchTerm}`)
    }
    if (query.from) {
      rowsQuery = rowsQuery.where(sql<boolean>`coalesce(occurred_at, scheduled_at, created_at) >= ${query.from}`)
    }
    if (query.to) {
      rowsQuery = rowsQuery.where(sql<boolean>`coalesce(occurred_at, scheduled_at, created_at) <= ${query.to}`)
    }

    if (cursor) {
      const op = sortDir === 'asc' ? '>' : '<'
      const opRaw = sql.raw(op)
      const sortRaw = sql.raw(sortSql)
      rowsQuery = rowsQuery.where((eb: any) => eb.or([
        sql<boolean>`${sortRaw} ${opRaw} ${cursor.sortValue}`,
        eb.and([
          sql<boolean>`${sortRaw} = ${cursor.sortValue}`,
          eb('id', op, cursor.id),
        ]),
      ]))
    }

    const viewerUserId = auth.isApiKey ? null : (auth.sub ?? null)
    const callerUserFeatures = viewerUserId
      ? await resolveUserFeatures(container, viewerUserId, auth.tenantId ?? null, selectedOrganizationId)
      : undefined
    rowsQuery = applyEmailVisibilityFilter(rowsQuery as any, {
      currentUserId: viewerUserId,
      userFeatures: callerUserFeatures,
    })

    rowsQuery = rowsQuery.orderBy(sql`${sql.raw(sortSql)} ${sql.raw(sortDir)}`).orderBy('id', sortDir)

    const rows = await rowsQuery.execute() as InteractionListRow[]
    const pageRows = rows.slice(0, query.limit)
    const hasMore = rows.length > query.limit

    const authorIds = Array.from(new Set(
      pageRows.map((row) => (typeof row.author_user_id === 'string' ? row.author_user_id : null))
        .filter((v): v is string => !!v),
    ))
    const dealIds = Array.from(new Set(
      pageRows.map((row) => (typeof row.deal_id === 'string' ? row.deal_id : null))
        .filter((v): v is string => !!v),
    ))
    const interactionIds = pageRows.map((row) => row.id)

    const [users, deals, customFieldValues, interactionRecords] = await Promise.all([
      authorIds.length > 0
        ? findWithDecryption(em, User, { id: { $in: authorIds } }, undefined, { tenantId: auth.tenantId, organizationId: selectedOrganizationId })
        : Promise.resolve([]),
      dealIds.length > 0
        ? findWithDecryption(em, CustomerDeal, { id: { $in: dealIds } }, undefined, { tenantId: auth.tenantId, organizationId: selectedOrganizationId })
        : Promise.resolve([]),
      interactionIds.length > 0
        ? loadCustomFieldValues({
            em,
            entityId: CUSTOMER_INTERACTION_ENTITY_ID,
            recordIds: interactionIds,
            tenantIdByRecord: Object.fromEntries(pageRows.map((row) => [row.id, row.tenant_id])),
            organizationIdByRecord: Object.fromEntries(pageRows.map((row) => [row.id, row.organization_id])),
            tenantFallbacks: [auth.tenantId].filter((v): v is string => !!v),
          })
        : Promise.resolve<Record<string, Record<string, unknown>>>({}),
      interactionIds.length > 0
        ? findWithDecryption(em, CustomerInteraction, { id: { $in: interactionIds } } as never, undefined, { tenantId: auth.tenantId, organizationId: selectedOrganizationId })
        : Promise.resolve([]),
    ])

    const userMap = new Map(users.map((u) => [u.id, { name: u.name ?? null, email: u.email ?? null }]))
    const dealMap = new Map(deals.map((d) => [d.id, d.title]))
    const interactionContentMap = new Map(
      (interactionRecords as Array<{ id: string; title?: string | null; body?: string | null }>)
        .map((record) => [record.id, { title: record.title ?? null, body: record.body ?? null }]),
    )

    const baseItems = pageRows.map((row) => ({
      id: row.id,
      entityId: row.entity_id,
      dealId: row.deal_id ?? null,
      interactionType: row.interaction_type,
      title: (interactionContentMap.has(row.id) ? interactionContentMap.get(row.id)!.title : row.title) ?? null,
      body: (interactionContentMap.has(row.id) ? interactionContentMap.get(row.id)!.body : row.body) ?? null,
      status: row.status,
      scheduledAt: toIsoString(row.scheduled_at),
      occurredAt: toIsoString(row.occurred_at),
      priority: row.priority ?? null,
      authorUserId: row.author_user_id ?? null,
      ownerUserId: row.owner_user_id ?? null,
      appearanceIcon: row.appearance_icon ?? null,
      appearanceColor: row.appearance_color ?? null,
      source: row.source ?? null,
      duration: row.duration_minutes ?? null,
      durationMinutes: row.duration_minutes ?? null,
      location: row.location ?? null,
      allDay: row.all_day ?? null,
      recurrenceRule: row.recurrence_rule ?? null,
      recurrenceEnd: toIsoString(row.recurrence_end),
      participants: row.participants ?? null,
      reminderMinutes: row.reminder_minutes ?? null,
      visibility: row.visibility ?? null,
      linkedEntities: row.linked_entities ?? null,
      guestPermissions: row.guest_permissions ?? null,
      pinned: row.pinned ?? false,
      organizationId: row.organization_id,
      tenantId: row.tenant_id,
      createdAt: toIsoString(row.created_at) ?? new Date().toISOString(),
      updatedAt: toIsoString(row.updated_at) ?? new Date().toISOString(),
      authorName: row.author_user_id ? userMap.get(row.author_user_id)?.name ?? null : null,
      authorEmail: row.author_user_id ? userMap.get(row.author_user_id)?.email ?? null : null,
      dealTitle: row.deal_id ? dealMap.get(row.deal_id) ?? null : null,
      customValues: normalizeCustomFieldResponse(customFieldValues[row.id]) ?? null,
    }))

    const enricherContext = await buildEnricherContext(
      container,
      auth,
      selectedOrganizationId,
      viewerUserId ? { userId: viewerUserId, features: callerUserFeatures } : undefined,
    )
    const enriched = await applyResponseEnrichers(baseItems, 'customers.interaction', enricherContext)

    let nextCursor: string | undefined
    if (hasMore && pageRows.length > 0) {
      const last = pageRows[pageRows.length - 1]
      nextCursor = encodeCursor({
        id: last.id,
        sortValue: normalizeCursorValue(last.__sort_value, sortConfig.type),
      })
    }

    return NextResponse.json({ items: enriched.items, nextCursor })
  } catch (err) {
    if (isCrudHttpError(err)) {
      return NextResponse.json(err.body, { status: err.status })
    }
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: 'Validation failed', details: err.issues }, { status: 400 })
    }
    console.error('channel_office365.interactions.get failed', err)
    const { translate } = await resolveTranslations()
    return NextResponse.json(
      { error: translate('customers.interactions.load.error', 'Failed to load interactions.') },
      { status: 500 },
    )
  }
}

// ─── Counts override ─────────────────────────────────────────────────────────
// Mirrors GET /api/customers/interactions/counts from core but applies the same
// D365-style company expansion so tab counters match the interaction list.

const countsQuerySchema = z.object({
  entityId: z.string().uuid(),
  status: z.enum(['done', 'planned']).optional(),
})

export async function getInteractionCounts(req: Request) {
  try {
    const queryUrl = new URL(req.url)
    const query = countsQuerySchema.parse(Object.fromEntries(queryUrl.searchParams))
    const container = await createRequestContainer()
    const auth = await getAuthFromRequest(req)
    const { translate } = await resolveTranslations()

    if (!auth || !auth.tenantId) {
      throw new CrudHttpError(401, {
        error: translate('customers.errors.unauthorized', 'Unauthorized'),
      })
    }

    const scope = await resolveOrganizationScopeForRequest({ container, auth, request: req })
    const organizationIds = Array.isArray(scope?.filterIds) && scope.filterIds.length > 0
      ? scope.filterIds
      : auth.orgId
        ? [auth.orgId]
        : []
    const em = (container.resolve('em') as EntityManager).fork()
    const db = em.getKysely<any>() as any

    const entityIds = await resolveExpandedEntityIds(db, query.entityId, auth.tenantId)

    let baseQuery = db
      .selectFrom('customer_interactions')
      .where('tenant_id', '=', auth.tenantId)
      .where('deleted_at', 'is', null)

    if (entityIds.length === 1) {
      baseQuery = baseQuery.where('entity_id', '=', entityIds[0])
    } else {
      baseQuery = baseQuery.where('entity_id', 'in', entityIds)
    }

    if (organizationIds.length === 1) {
      baseQuery = baseQuery.where('organization_id', '=', organizationIds[0])
    } else if (organizationIds.length > 1) {
      baseQuery = baseQuery.where('organization_id', 'in', organizationIds)
    }

    if (query.status) {
      baseQuery = baseQuery.where('status', '=', query.status)
    }

    const viewerUserId = auth.isApiKey ? null : auth.sub ?? null
    baseQuery = applyEmailVisibilityFilter(baseQuery, {
      currentUserId: viewerUserId,
      userFeatures: undefined,
    })

    const rows = await baseQuery
      .select(['interaction_type', sql<string>`count(*)`.as('count')])
      .groupBy('interaction_type')
      .execute() as Array<{ interaction_type: string; count: string | number }>

    const counts: Record<string, number> = { call: 0, email: 0, meeting: 0, note: 0, task: 0 }
    let total = 0
    for (const row of rows) {
      const count = typeof row.count === 'string' ? parseInt(row.count, 10) : row.count
      const type = row.interaction_type
      if (type in counts) counts[type] = count
      total += count
    }

    return NextResponse.json({ ok: true, result: { ...counts, total } })
  } catch (err) {
    if (isCrudHttpError(err)) {
      return NextResponse.json(err.body, { status: err.status })
    }
    console.error('channel_office365.interactions.counts failed', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

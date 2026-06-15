import { z } from 'zod'

export const ACTIVITY_STATUSES = ['not_started', 'in_progress', 'completed', 'cancelled'] as const
export type ActivityStatus = typeof ACTIVITY_STATUSES[number]

export const LIFECYCLE_MODES = ['fact', 'task'] as const
export type LifecycleMode = typeof LIFECYCLE_MODES[number]

export const VISIBILITY_OPTIONS = ['private', 'team', 'public'] as const
export type ActivityVisibility = typeof VISIBILITY_OPTIONS[number]

export const SYNC_DIRECTIONS = ['inbound', 'outbound', 'bidirectional'] as const

const participantSchema = z.object({
  userId: z.string().uuid().optional(),
  name: z.string().max(200).optional(),
  email: z.string().email().optional(),
  status: z.string().max(50).optional(),
})

export const activityCreateSchema = z.object({
  id: z.string().uuid().optional(),
  activityType: z.string().min(1).max(100),
  lifecycleMode: z.enum(LIFECYCLE_MODES),
  subject: z.string().min(1).max(500),
  notes: z.string().max(10000).nullable().optional(),
  status: z.enum(ACTIVITY_STATUSES).optional(),
  priority: z.number().int().min(0).max(100).nullable().optional(),
  dueAt: z.string().datetime({ offset: true }).nullable().optional(),
  occurredAt: z.string().datetime({ offset: true }).nullable().optional(),
  durationMinutes: z.number().int().min(0).max(1440).nullable().optional(),
  location: z.string().max(500).nullable().optional(),
  allDay: z.boolean().optional(),
  recurrenceRule: z.string().max(500).nullable().optional(),
  ownerUserId: z.string().uuid().nullable().optional(),
  participants: z.array(participantSchema).nullable().optional(),
  visibility: z.enum(VISIBILITY_OPTIONS).optional(),
  linkedEntityType: z.string().max(100).nullable().optional(),
  linkedEntityId: z.string().uuid().nullable().optional(),
  externalId: z.string().max(500).nullable().optional(),
  externalProvider: z.string().max(100).nullable().optional(),
  syncDirection: z.enum(SYNC_DIRECTIONS).nullable().optional(),
  sourceType: z.string().max(100).nullable().optional(),
  sourceId: z.string().uuid().nullable().optional(),
}).refine(
  (data) => {
    // linkedEntityId requires linkedEntityType and vice versa
    const hasType = !!data.linkedEntityType
    const hasId = !!data.linkedEntityId
    return hasType === hasId
  },
  { message: 'linkedEntityType and linkedEntityId must both be provided or both omitted', path: ['linkedEntityId'] }
).refine(
  (data) => {
    // externalId requires externalProvider
    if (data.externalId && !data.externalProvider) return false
    return true
  },
  { message: 'externalProvider is required when externalId is provided', path: ['externalProvider'] }
).refine(
  (data) => {
    // private visibility only allowed for task mode
    if (data.visibility === 'private' && data.lifecycleMode === 'fact') return false
    return true
  },
  { message: 'Private visibility is not allowed for fact-mode activities', path: ['visibility'] }
)

export const activityUpdateSchema = z.object({
  id: z.string().uuid(),
  subject: z.string().min(1).max(500).optional(),
  notes: z.string().max(10000).nullable().optional(),
  status: z.enum(ACTIVITY_STATUSES).optional(),
  priority: z.number().int().min(0).max(100).nullable().optional(),
  dueAt: z.string().datetime({ offset: true }).nullable().optional(),
  occurredAt: z.string().datetime({ offset: true }).nullable().optional(),
  durationMinutes: z.number().int().min(0).max(1440).nullable().optional(),
  location: z.string().max(500).nullable().optional(),
  allDay: z.boolean().optional(),
  ownerUserId: z.string().uuid().nullable().optional(),
  participants: z.array(participantSchema).nullable().optional(),
  visibility: z.enum(VISIBILITY_OPTIONS).optional(),
  linkedEntityType: z.string().max(100).nullable().optional(),
  linkedEntityId: z.string().uuid().nullable().optional(),
  sourceType: z.string().max(100).nullable().optional(),
  sourceId: z.string().uuid().nullable().optional(),
}).refine(
  (data) => {
    const hasType = data.linkedEntityType !== undefined ? !!data.linkedEntityType : undefined
    const hasId = data.linkedEntityId !== undefined ? !!data.linkedEntityId : undefined
    if (hasType === undefined && hasId === undefined) return true
    if (hasType !== undefined && hasId !== undefined) return hasType === hasId
    return true
  },
  { message: 'linkedEntityType and linkedEntityId must both be provided or both omitted', path: ['linkedEntityId'] }
)

export const activityCompleteSchema = z.object({
  occurredAt: z.string().datetime({ offset: true }).nullable().optional(),
  notes: z.string().max(10000).nullable().optional(),
  durationMinutes: z.number().int().min(0).max(1440).nullable().optional(),
})

export const activityCancelSchema = z.object({
  reason: z.string().max(500).nullable().optional(),
})

export type ActivityCreate = z.infer<typeof activityCreateSchema>
export type ActivityUpdate = z.infer<typeof activityUpdateSchema>
export type ActivityComplete = z.infer<typeof activityCompleteSchema>
export type ActivityCancel = z.infer<typeof activityCancelSchema>

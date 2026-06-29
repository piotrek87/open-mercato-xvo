import type { ActivityTypeDefinition } from '../../../activity-types'
import type { ActivityCardData } from './DefaultActivityCard'

export type OptimisticActivity = ActivityCardData & {
  _isOptimistic?: true
  _tempId?: string
}

export function deriveSubjectAndNotes(text: string): { subject: string; notes: string | null } {
  const trimmed = text.trim()
  if (trimmed.length <= 100) return { subject: trimmed, notes: null }
  return { subject: trimmed.slice(0, 97) + '…', notes: trimmed }
}

export function parseParticipants(raw?: string): { email: string }[] {
  if (!raw?.trim()) return []
  return raw.split(',').map((e) => e.trim()).filter(Boolean).map((email) => ({ email }))
}

export function isInlineType(typeDef: ActivityTypeDefinition | undefined): boolean {
  if (!typeDef) return false
  return typeDef.lifecycleMode === 'fact' && !!typeDef.capabilities.hasBody
}

export function mergeWithFresh(
  current: OptimisticActivity[],
  fresh: ActivityCardData[],
): OptimisticActivity[] {
  const freshIds = new Set(fresh.map((a) => a.id))
  const optimistic = current.filter((a) => a._isOptimistic && !freshIds.has(a.id))
  return [...optimistic, ...fresh]
}

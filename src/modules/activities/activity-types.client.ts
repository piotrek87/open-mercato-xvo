// Layer 1 client-side renderers for built-in activity types.
// Built-in types use DefaultActivityCard (no custom renderer needed).
// External modules declare custom renderers in their own activity-types.client.ts.

import type { ActivityCardData } from './widgets/injection/timeline/DefaultActivityCard'
import type { ActivityTypeDefinition } from './activity-types'
import type React from 'react'

export interface ActivityCardProps {
  activity: ActivityCardData
  typeDef: ActivityTypeDefinition
  onAction?: (actionId: string, activityId: string) => void
  compact?: boolean
}

export type ActivityTypeClientRenderers = {
  [typeId: string]: () => Promise<{ default: React.ComponentType<ActivityCardProps> }>
}

// Built-in types intentionally have no custom renderer — they fall through to DefaultActivityCard.
export const activityTypeRenderers: ActivityTypeClientRenderers = {}

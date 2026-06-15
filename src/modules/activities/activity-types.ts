export interface ActivityTypeCapabilities {
  hasDueDate?: boolean
  hasStatus?: boolean
  hasOwner?: boolean
  hasParticipants?: boolean
  hasRecurrence?: boolean
  hasExternalSync?: boolean
  hasLocation?: boolean
  hasBody?: boolean
}

export interface ActivityTypeAction {
  id: string
  label: string
  icon: string
  variant: 'default' | 'outline' | 'ghost' | 'destructive'
  feature?: string
  condition?: 'when_planned' | 'when_in_progress' | 'when_completed' | 'when_overdue' | 'always'
}

export interface ActivityTypeDefaultValues {
  status?: string
  visibility?: string
  priority?: number
  durationMinutes?: number
  occurredAt?: 'now' | null
  dueAt?: 'end_of_day' | null
}

export interface ActivityTypeDefinition {
  id: string
  moduleId: string
  label: string
  icon: string
  color?: string
  lifecycleMode: 'fact' | 'task'
  capabilities: ActivityTypeCapabilities
  viewFeature?: string
  createFeature?: string
  filterLabel?: string
  filterIcon?: string
  filterGroup?: string
  actions?: ActivityTypeAction[]
  primaryActionId?: string
  defaultValues?: ActivityTypeDefaultValues
}

export const activityTypes: ActivityTypeDefinition[] = [
  {
    id: 'email',
    moduleId: 'activities',
    label: 'activities.types.email',
    icon: 'Mail',
    lifecycleMode: 'fact',
    capabilities: { hasBody: true, hasParticipants: true },
    defaultValues: { occurredAt: 'now', visibility: 'team' },
  },
  {
    id: 'meeting',
    moduleId: 'activities',
    label: 'activities.types.meeting',
    icon: 'CalendarDays',
    lifecycleMode: 'task',
    capabilities: { hasDueDate: true, hasLocation: true, hasParticipants: true, hasRecurrence: true },
    defaultValues: { dueAt: 'end_of_day', visibility: 'team', durationMinutes: 60 },
  },
  {
    id: 'call',
    moduleId: 'activities',
    label: 'activities.types.call',
    icon: 'Phone',
    lifecycleMode: 'task',
    capabilities: { hasDueDate: true, hasParticipants: true },
    defaultValues: { dueAt: 'end_of_day', visibility: 'team', durationMinutes: 15 },
  },
  {
    id: 'note',
    moduleId: 'activities',
    label: 'activities.types.note',
    icon: 'FileText',
    lifecycleMode: 'fact',
    capabilities: { hasBody: true },
    defaultValues: { occurredAt: 'now', visibility: 'team' },
  },
  {
    id: 'task',
    moduleId: 'activities',
    label: 'activities.types.task',
    icon: 'CheckSquare',
    lifecycleMode: 'task',
    capabilities: { hasDueDate: true, hasStatus: true, hasOwner: true },
    defaultValues: { dueAt: 'end_of_day', visibility: 'team', status: 'not_started' },
  },
]

export function getAllActivityTypes(): ActivityTypeDefinition[] {
  return activityTypes
}

export function getActivityTypeById(id: string): ActivityTypeDefinition | undefined {
  return activityTypes.find((t) => t.id === id)
}

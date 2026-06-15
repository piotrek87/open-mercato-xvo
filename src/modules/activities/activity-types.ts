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
}

export const activityTypes: ActivityTypeDefinition[] = [
  {
    id: 'email',
    moduleId: 'activities',
    label: 'activities.types.email',
    icon: 'Mail',
    lifecycleMode: 'fact',
    capabilities: { hasBody: true, hasParticipants: true },
  },
  {
    id: 'meeting',
    moduleId: 'activities',
    label: 'activities.types.meeting',
    icon: 'CalendarDays',
    lifecycleMode: 'task',
    capabilities: { hasDueDate: true, hasLocation: true, hasParticipants: true, hasRecurrence: true },
  },
  {
    id: 'call',
    moduleId: 'activities',
    label: 'activities.types.call',
    icon: 'Phone',
    lifecycleMode: 'task',
    capabilities: { hasDueDate: true, hasParticipants: true },
  },
  {
    id: 'note',
    moduleId: 'activities',
    label: 'activities.types.note',
    icon: 'FileText',
    lifecycleMode: 'fact',
    capabilities: { hasBody: true },
  },
  {
    id: 'task',
    moduleId: 'activities',
    label: 'activities.types.task',
    icon: 'CheckSquare',
    lifecycleMode: 'task',
    capabilities: { hasDueDate: true, hasStatus: true, hasOwner: true },
  },
]

export function getAllActivityTypes(): ActivityTypeDefinition[] {
  return activityTypes
}

export function getActivityTypeById(id: string): ActivityTypeDefinition | undefined {
  return activityTypes.find((t) => t.id === id)
}

export type ActivityTypeDefinition = {
  id: string
  label: string
  icon: string
  lifecycleMode: 'fact' | 'task'
  color?: string
}

export const BUILT_IN_ACTIVITY_TYPES: ActivityTypeDefinition[] = [
  { id: 'email', label: 'Email', icon: 'Mail', lifecycleMode: 'fact' },
  { id: 'meeting', label: 'Meeting', icon: 'Users', lifecycleMode: 'fact' },
  { id: 'call', label: 'Call', icon: 'Phone', lifecycleMode: 'fact' },
  { id: 'note', label: 'Note', icon: 'FileText', lifecycleMode: 'fact' },
  { id: 'task', label: 'Task', icon: 'CheckSquare', lifecycleMode: 'task' },
]

export function getAllActivityTypes(): ActivityTypeDefinition[] {
  return BUILT_IN_ACTIVITY_TYPES
}

export function getActivityTypeById(id: string): ActivityTypeDefinition | undefined {
  return BUILT_IN_ACTIVITY_TYPES.find((t) => t.id === id)
}

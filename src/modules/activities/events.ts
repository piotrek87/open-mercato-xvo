import { createModuleEvents } from '@open-mercato/shared/modules/events'

const events = [
  {
    id: 'activities.activity.created',
    label: 'Activity Created',
    entity: 'activity',
    category: 'crud',
    clientBroadcast: true,
  },
  {
    id: 'activities.activity.updated',
    label: 'Activity Updated',
    entity: 'activity',
    category: 'crud',
    clientBroadcast: true,
  },
  {
    id: 'activities.activity.completed',
    label: 'Activity Completed',
    entity: 'activity',
    category: 'lifecycle',
    clientBroadcast: true,
  },
  {
    id: 'activities.activity.cancelled',
    label: 'Activity Cancelled',
    entity: 'activity',
    category: 'lifecycle',
    clientBroadcast: true,
  },
  {
    id: 'activities.activity.deleted',
    label: 'Activity Deleted',
    entity: 'activity',
    category: 'crud',
    clientBroadcast: true,
  },
  {
    id: 'activities.activity.restored',
    label: 'Activity Restored',
    entity: 'activity',
    category: 'lifecycle',
    clientBroadcast: true,
  },
] as const

export const eventsConfig = createModuleEvents({ moduleId: 'activities', events })
export const emitActivityEvent = eventsConfig.emit
export type ActivityEventId = (typeof events)[number]['id']

export default eventsConfig

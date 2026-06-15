export const features = [
  { id: 'activities.view', title: 'View activities', module: 'activities' },
  {
    id: 'activities.manage',
    title: 'Create, edit and delete activities',
    module: 'activities',
    dependsOn: ['activities.view'],
  },
  {
    id: 'activities.complete',
    title: 'Mark activities as completed',
    module: 'activities',
    dependsOn: ['activities.view'],
  },
  {
    id: 'activities.cancel',
    title: 'Cancel activities',
    module: 'activities',
    dependsOn: ['activities.view'],
  },
  {
    id: 'activities.view_private',
    title: 'View private activities of other users',
    module: 'activities',
    dependsOn: ['activities.view'],
  },
]

export default features

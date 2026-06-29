export const features = [
  {
    id: 'channel_office365.view',
    title: 'View Office 365 Calendar connection',
    module: 'channel_office365',
    dependsOn: [],
  },
  {
    id: 'channel_office365.configure',
    title: 'Connect and disconnect Office 365 Calendar',
    module: 'channel_office365',
    dependsOn: ['channel_office365.view'],
  },
  {
    id: 'channel_office365.manage',
    title: 'Manage Office 365 email channel settings (attachments, sync)',
    module: 'channel_office365',
    dependsOn: ['channel_office365.view'],
  },
]

export default features

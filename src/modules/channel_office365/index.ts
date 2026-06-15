import type { ModuleInfo } from '@open-mercato/shared/modules/registry'

export const metadata: ModuleInfo = {
  name: 'channel_office365',
  title: 'Office 365 Calendar',
  version: '0.1.0',
  description: 'Microsoft 365 calendar integration — syncs events to Activities via Graph Calendar Delta API.',
  author: 'OpenMercato',
  license: 'MIT',
}

export { features } from './acl'

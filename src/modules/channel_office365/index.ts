import type { ModuleInfo } from '@open-mercato/shared/modules/registry'

export const metadata: ModuleInfo = {
  name: 'channel_office365',
  title: 'Microsoft 365',
  version: '0.2.0',
  description: 'Unified Microsoft 365 connector — per-user OAuth2, calendar sync + mail sync (Phase 2) via Graph Delta API.',
  author: 'OpenMercato',
  license: 'MIT',
}

export { features } from './acl'

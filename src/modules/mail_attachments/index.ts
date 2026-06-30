import type { ModuleInfo } from '@open-mercato/shared/modules/registry'

export const metadata: ModuleInfo = {
  name: 'mail_attachments',
  title: 'Mail Attachments',
  version: '0.1.0',
  description:
    'Provider-agnostic outbound mail attachment storage + resolver (references → files). Consumed by channel adapters (O365, future Gmail) via DI; no provider assumptions.',
  author: 'OpenMercato',
  license: 'MIT',
}

export { features } from './acl'

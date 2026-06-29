import {
  buildIntegrationDetailWidgetSpotId,
  type IntegrationBundle,
  type IntegrationDefinition,
} from '@open-mercato/shared/modules/integrations/types'
import { O365_INTEGRATION_ID, O365_PROVIDER_KEY } from './lib/credentials'

export const channelOffice365DetailWidgetSpotId = buildIntegrationDetailWidgetSpotId(O365_INTEGRATION_ID)

export const integration: IntegrationDefinition = {
  id: O365_INTEGRATION_ID,
  title: 'Microsoft 365',
  description:
    'Connect per-user Microsoft 365 accounts via OAuth2. Syncs calendar events and (Sprint 5) emails to Activities via Graph Delta API. Each staff member connects their own account — per-user OAuth, per-user sync.',
  category: 'communication',
  hub: 'communication_channels',
  providerKey: O365_PROVIDER_KEY,
  icon: 'calendar',
  docsUrl: 'https://learn.microsoft.com/en-us/graph/api/overview',
  package: '@app/channel_office365',
  version: '0.2.0',
  author: 'OpenMercato',
  company: 'OpenMercato',
  license: 'MIT',
  tags: ['office365', 'microsoft', 'm365', 'calendar', 'email', 'oauth2', 'activities'],
  detailPage: {
    widgetSpotId: channelOffice365DetailWidgetSpotId,
  },
  apiVersions: [
    {
      id: 'v1.0',
      label: 'Microsoft Graph API v1.0',
      status: 'stable',
      default: true,
      changelog: 'Graph Delta API with OAuth2 per-user auth. Calendar sync + Mail sync (Phase 2).',
    },
  ],
  credentials: {
    fields: [
      {
        key: 'clientId',
        label: 'Azure Application (client) ID',
        type: 'text',
        required: true,
        placeholder: '00000000-0000-0000-0000-000000000000',
        helpText:
          'Azure portal → App registrations → your app → Overview → Application (client) ID. Add redirect URI: <yourdomain>/api/communication_channels/oauth/office365/callback',
      },
      {
        key: 'clientSecret',
        label: 'Client Secret',
        type: 'secret',
        required: true,
        helpText: 'Azure portal → App registrations → your app → Certificates & secrets → New client secret. Stored encrypted.',
      },
      {
        key: 'tenantId',
        label: 'Azure AD Tenant ID (optional)',
        type: 'text',
        required: false,
        placeholder: 'xentivo.pl or 00000000-0000-0000-0000-000000000000',
        helpText:
          'Azure portal → Azure Active Directory → Overview → Primary domain or Tenant ID (GUID). When set, uses tenant-specific login endpoint — required when admin consent is configured for a specific directory. Leave empty for multi-tenant apps.',
      },
    ],
  },
  healthCheck: { service: 'channelOffice365HealthCheck' },
}

export const integrations: IntegrationDefinition[] = [integration]
export const bundles: IntegrationBundle[] = []
export const bundle: IntegrationBundle | undefined = undefined

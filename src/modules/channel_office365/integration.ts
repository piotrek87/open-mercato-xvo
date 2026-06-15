import {
  buildIntegrationDetailWidgetSpotId,
  type IntegrationBundle,
  type IntegrationDefinition,
} from '@open-mercato/shared/modules/integrations/types'

export const channelOffice365DetailWidgetSpotId = buildIntegrationDetailWidgetSpotId('channel_office365_calendar')

export const integration: IntegrationDefinition = {
  id: 'channel_office365_calendar',
  title: 'Office 365 Calendar',
  description:
    'Connect per-user Microsoft 365 accounts via OAuth2. Syncs calendar events to Activities (meeting type) every 5 minutes using the Graph Calendar Delta API.',
  category: 'communication',
  hub: 'communication_channels',
  providerKey: 'office365_calendar',
  icon: 'calendar',
  docsUrl: 'https://learn.microsoft.com/en-us/graph/api/event-delta',
  package: '@app/channel_office365',
  version: '0.1.0',
  author: 'OpenMercato',
  company: 'OpenMercato',
  license: 'MIT',
  tags: ['calendar', 'office365', 'microsoft', 'oauth2', 'activities'],
  detailPage: {
    widgetSpotId: channelOffice365DetailWidgetSpotId,
  },
  apiVersions: [
    {
      id: 'v1.0',
      label: 'Microsoft Graph API v1.0',
      status: 'stable',
      default: true,
      changelog: 'Graph Calendar Delta API with OAuth2 per-user auth.',
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
          'Azure portal → App registrations → your app → Overview → Application (client) ID. Add redirect URI: <yourdomain>/api/communication_channels/oauth/office365_calendar/callback',
      },
      {
        key: 'clientSecret',
        label: 'Client Secret',
        type: 'secret',
        required: true,
        helpText: 'Azure portal → App registrations → your app → Certificates & secrets → New client secret. Stored encrypted.',
      },
    ],
  },
  healthCheck: { service: 'channelOffice365CalendarHealthCheck' },
}

export const integrations: IntegrationDefinition[] = [integration]
export const bundles: IntegrationBundle[] = []
export const bundle: IntegrationBundle | undefined = undefined

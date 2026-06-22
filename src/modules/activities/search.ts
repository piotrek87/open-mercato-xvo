import type { SearchModuleConfig, SearchBuildContext } from '@open-mercato/shared/modules/search'

export const searchConfig: SearchModuleConfig = {
  entities: [{
    entityId: 'activities:activity',
    priority: 15,

    fieldPolicy: {
      searchable: ['subject', 'notes', 'location'],
      excluded: ['externalId', 'metadata'],
    },

    formatResult: async (ctx: SearchBuildContext) => ({
      title: String(ctx.record.subject ?? ''),
      subtitle: String(ctx.record.activityType ?? ''),
      icon: 'lucide:calendar',
      badge: 'Activity',
    }),

    buildSource: async (ctx: SearchBuildContext) => ({
      text: [
        ctx.record.subject ? `Subject: ${ctx.record.subject}` : '',
        ctx.record.notes ? `Notes: ${ctx.record.notes}` : '',
        ctx.record.activityType ? `Type: ${ctx.record.activityType}` : '',
      ].filter(Boolean),
      presenter: {
        title: String(ctx.record.subject ?? ''),
        subtitle: String(ctx.record.activityType ?? ''),
        icon: 'lucide:calendar',
        badge: 'Activity',
      },
      links: [{ href: `/backend/activities/${ctx.record.id}`, label: 'View', kind: 'primary' as const }],
      checksumSource: { record: ctx.record, customFields: ctx.customFields },
    }),

    resolveUrl: async (ctx) => `/backend/activities/${ctx.record.id}`,
  }],
}

export default searchConfig

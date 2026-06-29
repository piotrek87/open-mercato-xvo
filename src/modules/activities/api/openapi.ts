import { z } from 'zod'
import { createCrudOpenApiFactory } from '@open-mercato/shared/lib/openapi/crud'

export const activitiesTag = 'Activities'

export const buildActivitiesCrudOpenApi = createCrudOpenApiFactory({
  defaultTag: activitiesTag,
})

export const activityOkSchema = z.object({ ok: z.boolean() })
export const activityCreatedSchema = z.object({ id: z.string().uuid() })

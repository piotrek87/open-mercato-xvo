import { type ActivityEventPayload, handleOutboundCreateOrUpdate } from './activity-o365-outbound'

export const metadata = {
  event: 'activities.activity.created',
  persistent: true,
  id: 'channel_office365.activity-o365-outbound-created',
}

export default async function handler(payload: ActivityEventPayload): Promise<void> {
  await handleOutboundCreateOrUpdate(payload)
}

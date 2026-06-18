import { type ActivityEventPayload, handleOutboundDelete } from './activity-o365-outbound'

export const metadata = {
  event: 'activities.activity.deleted',
  persistent: true,
  id: 'channel_office365.activity-o365-outbound-deleted',
}

export default async function handler(payload: ActivityEventPayload): Promise<void> {
  await handleOutboundDelete(payload)
}

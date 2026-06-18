import { type InteractionEventPayload, handleOutboundCreateOrUpdate } from './activity-o365-outbound'

export const metadata = {
  event: 'customers.interaction.updated',
  persistent: true,
  id: 'channel_office365.activity-o365-outbound-updated',
}

export default async function handler(payload: InteractionEventPayload): Promise<void> {
  await handleOutboundCreateOrUpdate(payload)
}

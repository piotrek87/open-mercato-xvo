import { type InteractionEventPayload, handleOutboundDelete } from './activity-o365-outbound'

export const metadata = {
  event: 'customers.interaction.deleted',
  persistent: true,
  id: 'channel_office365.activity-o365-outbound-deleted',
}

export default async function handler(payload: InteractionEventPayload): Promise<void> {
  await handleOutboundDelete(payload)
}

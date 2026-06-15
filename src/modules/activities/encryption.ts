import type { ModuleEncryptionMap } from '@open-mercato/shared/modules/encryption'

export const defaultEncryptionMaps: ModuleEncryptionMap[] = [
  {
    entityId: 'activities:activity',
    fields: [{ field: 'subject' }, { field: 'notes' }, { field: 'location' }],
  },
]

export default defaultEncryptionMaps

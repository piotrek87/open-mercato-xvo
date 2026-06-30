import { asFunction } from 'awilix'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { AppContainer } from '@open-mercato/shared/lib/di/container'
import type { StorageDriverFactory } from '@open-mercato/core/modules/attachments/lib/drivers/driverFactory'
import { AttachmentMailSource } from './lib/attachment-source'
import { createMailAttachmentResolver } from './lib/resolver'
import type { MailAttachmentResolver } from './lib/types'

/**
 * Registers the provider-agnostic `mailAttachmentResolver`. Any channel adapter (O365 now, Gmail
 * later) resolves it by this DI name — no cross-module import of internals. Transient so each
 * resolution binds the current scope's `em`; correctness is enforced by explicit scope filters in
 * the source, not by the em's ambient scope.
 */
export function register(container: AppContainer): void {
  container.register({
    mailAttachmentResolver: asFunction(
      ({ em, storageDriverFactory }: { em: EntityManager; storageDriverFactory: StorageDriverFactory }): MailAttachmentResolver =>
        createMailAttachmentResolver([new AttachmentMailSource(em, storageDriverFactory)]),
    ),
  })
}

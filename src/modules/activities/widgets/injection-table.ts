import type { ModuleInjectionTable } from '@open-mercato/shared/modules/widgets/injection'

/**
 * Activities module injection table
 *
 * The "Microsoft 365" tab (an injected ActivityTimeline widget on customer/sales detail pages)
 * was removed: O365 activities already appear in the built-in "Aktywności" + "Historia
 * interakcji" panels via customer_interactions, so a second timeline tab only confused users
 * about where activities live. The global /backend/activities page is unaffected.
 *
 * Left intentionally empty (rather than deleting the file) so the widget can be re-injected
 * later by re-adding spot mappings here.
 */
const injectionTable: ModuleInjectionTable = {}

export { injectionTable }
export default injectionTable

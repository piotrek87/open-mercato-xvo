import { redirect } from 'next/navigation'

// CustomerInteraction list page is deprecated — Activities is the canonical list.
export default function CustomerInteractionsRedirectPage() {
  return redirect('/backend/activities')
}

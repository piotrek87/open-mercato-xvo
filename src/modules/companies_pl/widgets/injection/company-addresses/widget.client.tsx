'use client'

import * as React from 'react'
import { MapPin, RefreshCw, Star } from 'lucide-react'
import type { InjectionWidgetComponentProps } from '@open-mercato/shared/modules/widgets/injection'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { Button } from '@open-mercato/ui/primitives/button'
import { Spinner } from '@open-mercato/ui/primitives/spinner'
import { EmptyState } from '@open-mercato/ui/backend/EmptyState'

type AddressItem = {
  id: string
  name: string | null
  address_line1: string
  address_line2: string | null
  building_number: string | null
  flat_number: string | null
  city: string | null
  postal_code: string | null
  country: string | null
  is_primary: boolean
  purpose: string | null
}

type AddressesResponse = {
  items?: AddressItem[]
  data?: AddressItem[]
  total?: number
}

function formatAddress(addr: AddressItem): string {
  const parts: string[] = []
  if (addr.address_line1) {
    parts.push(addr.building_number ? `${addr.address_line1} ${addr.building_number}` : addr.address_line1)
  }
  if (addr.address_line2) parts.push(addr.address_line2)
  if (addr.postal_code || addr.city) parts.push([addr.postal_code, addr.city].filter(Boolean).join(' '))
  if (addr.country) parts.push(addr.country)
  return parts.join(', ')
}

export default function CompanyAddressesWidget({
  context,
  data,
}: InjectionWidgetComponentProps<{ companyId?: string | null }, unknown>) {
  const companyId =
    context?.companyId ??
    (data as { company?: { id?: string } } | undefined)?.company?.id ??
    null

  const [addresses, setAddresses] = React.useState<AddressItem[] | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const fetchAddresses = React.useCallback(async () => {
    if (!companyId) return
    setLoading(true)
    setError(null)
    try {
      const { ok, result } = await apiCall<AddressesResponse>(
        `/api/customers/addresses?entityId=${encodeURIComponent(companyId)}&pageSize=50`,
      )
      if (ok && result) {
        setAddresses(result.items ?? result.data ?? [])
      } else {
        setError('Nie udało się załadować adresów.')
      }
    } catch {
      setError('Nie udało się załadować adresów.')
    } finally {
      setLoading(false)
    }
  }, [companyId])

  React.useEffect(() => {
    void fetchAddresses()
  }, [fetchAddresses])

  if (!companyId) return null

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {addresses == null ? '' : addresses.length === 0 ? 'Brak adresów' : `${addresses.length} adres${addresses.length === 1 ? '' : addresses.length < 5 ? 'y' : 'ów'}`}
        </p>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => void fetchAddresses()}
          disabled={loading}
          aria-label="Odśwież listę adresów"
        >
          {loading ? <Spinner className="h-3.5 w-3.5" /> : <RefreshCw className="h-3.5 w-3.5" />}
          <span className="ml-1.5">Odśwież</span>
        </Button>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {loading && addresses === null && (
        <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
          <Spinner className="h-4 w-4" />
          Ładowanie adresów…
        </div>
      )}

      {!loading && addresses !== null && addresses.length === 0 && (
        <EmptyState
          title="Brak adresów"
          description="Do tej firmy nie przypisano jeszcze żadnych adresów."
        />
      )}

      {addresses !== null && addresses.length > 0 && (
        <div className="space-y-2">
          {addresses.map((addr) => (
            <div key={addr.id} className="flex items-start gap-3 rounded-lg border p-4">
              <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1 space-y-0.5">
                <div className="flex items-center gap-2">
                  {addr.name && <span className="text-sm font-medium">{addr.name}</span>}
                  {addr.is_primary && (
                    <span className="flex items-center gap-0.5 text-xs text-muted-foreground">
                      <Star className="h-3 w-3" />
                      główny
                    </span>
                  )}
                  {addr.purpose && (
                    <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                      {addr.purpose}
                    </span>
                  )}
                </div>
                <p className="text-sm text-muted-foreground">{formatAddress(addr)}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

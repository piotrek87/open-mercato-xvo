'use client'

import * as React from 'react'
import { MapPin, Plus, RefreshCw, Star, Trash2, X } from 'lucide-react'
import type { InjectionWidgetComponentProps } from '@open-mercato/shared/modules/widgets/injection'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { Button } from '@open-mercato/ui/primitives/button'
import { Input } from '@open-mercato/ui/primitives/input'
import { Label } from '@open-mercato/ui/primitives/label'
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

type NewAddressForm = {
  name: string
  addressLine1: string
  city: string
  postalCode: string
  country: string
}

const EMPTY_FORM: NewAddressForm = { name: '', addressLine1: '', city: '', postalCode: '', country: 'PL' }

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
  const [deletingId, setDeletingId] = React.useState<string | null>(null)
  const [showForm, setShowForm] = React.useState(false)
  const [form, setForm] = React.useState<NewAddressForm>(EMPTY_FORM)
  const [saving, setSaving] = React.useState(false)
  const [formError, setFormError] = React.useState<string | null>(null)

  const fetchAddresses = React.useCallback(async () => {
    if (!companyId) return
    setLoading(true)
    setError(null)
    try {
      const { ok, result } = await apiCall<AddressesResponse>(
        `/api/customers/addresses?entityId=${encodeURIComponent(companyId)}&pageSize=50`,
      )
      if (ok && result) setAddresses(result.items ?? result.data ?? [])
      else setError('Nie udało się załadować adresów.')
    } catch {
      setError('Nie udało się załadować adresów.')
    } finally {
      setLoading(false)
    }
  }, [companyId])

  React.useEffect(() => {
    void fetchAddresses()
  }, [fetchAddresses])

  const handleDelete = React.useCallback(
    async (id: string) => {
      setDeletingId(id)
      try {
        const { ok, result } = await apiCall('/api/customers/addresses', {
          method: 'DELETE',
          body: JSON.stringify({ id }),
        })
        if (!ok) {
          const msg = (result as { error?: string } | undefined)?.error ?? 'Nie udało się usunąć adresu.'
          setError(msg)
        } else {
          setAddresses((prev) => prev?.filter((a) => a.id !== id) ?? null)
        }
      } catch {
        setError('Nie udało się usunąć adresu.')
      } finally {
        setDeletingId(null)
      }
    },
    [],
  )

  const handleAdd = React.useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault()
      if (!companyId) return
      if (!form.addressLine1.trim()) { setFormError('Ulica i numer są wymagane.'); return }
      setSaving(true)
      setFormError(null)
      try {
        const body: Record<string, string> = {
          entityId: companyId,
          addressLine1: form.addressLine1.trim(),
          country: form.country.trim() || 'PL',
        }
        if (form.name.trim()) body.name = form.name.trim()
        if (form.city.trim()) body.city = form.city.trim()
        if (form.postalCode.trim()) body.postalCode = form.postalCode.trim()
        const { ok, result } = await apiCall('/api/customers/addresses', {
          method: 'POST',
          body: JSON.stringify(body),
        })
        if (!ok) {
          const msg = (result as { error?: string } | undefined)?.error ?? 'Nie udało się dodać adresu.'
          setFormError(msg)
        } else {
          setShowForm(false)
          setForm(EMPTY_FORM)
          await fetchAddresses()
        }
      } catch {
        setFormError('Nie udało się dodać adresu.')
      } finally {
        setSaving(false)
      }
    },
    [companyId, form, fetchAddresses],
  )

  if (!companyId) return null

  const count = addresses?.length ?? 0

  return (
    <div className="space-y-4">
      {/* Header row */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {addresses == null ? '' : count === 0 ? 'Brak adresów' : `${count} adres${count === 1 ? '' : count < 5 ? 'y' : 'ów'}`}
        </p>
        <div className="flex items-center gap-2">
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
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => { setShowForm((v) => !v); setFormError(null) }}
          >
            {showForm ? <X className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
            <span className="ml-1.5">{showForm ? 'Anuluj' : 'Dodaj adres'}</span>
          </Button>
        </div>
      </div>

      {/* Inline add form */}
      {showForm && (
        <form onSubmit={(e) => void handleAdd(e)} className="rounded-lg border p-4 space-y-3">
          <p className="text-sm font-medium">Nowy adres</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="addr-name">Nazwa (opcjonalnie)</Label>
              <Input
                id="addr-name"
                placeholder="np. Siedziba główna"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="addr-line1">Ulica i numer <span className="text-destructive">*</span></Label>
              <Input
                id="addr-line1"
                placeholder="np. ul. Bakalarska 34"
                value={form.addressLine1}
                onChange={(e) => setForm((f) => ({ ...f, addressLine1: e.target.value }))}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="addr-postal">Kod pocztowy</Label>
              <Input
                id="addr-postal"
                placeholder="00-000"
                value={form.postalCode}
                onChange={(e) => setForm((f) => ({ ...f, postalCode: e.target.value }))}
                maxLength={10}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="addr-city">Miasto</Label>
              <Input
                id="addr-city"
                placeholder="Warszawa"
                value={form.city}
                onChange={(e) => setForm((f) => ({ ...f, city: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="addr-country">Kraj</Label>
              <Input
                id="addr-country"
                placeholder="PL"
                value={form.country}
                onChange={(e) => setForm((f) => ({ ...f, country: e.target.value }))}
                maxLength={5}
              />
            </div>
          </div>
          {formError && <p className="text-sm text-destructive">{formError}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => { setShowForm(false); setForm(EMPTY_FORM) }}>
              Anuluj
            </Button>
            <Button type="submit" size="sm" disabled={saving}>
              {saving ? <Spinner className="mr-1.5 h-3.5 w-3.5" /> : null}
              Zapisz adres
            </Button>
          </div>
        </form>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}

      {loading && addresses === null && (
        <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
          <Spinner className="h-4 w-4" />
          Ładowanie adresów…
        </div>
      )}

      {!loading && addresses !== null && addresses.length === 0 && !showForm && (
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
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="shrink-0 text-muted-foreground hover:text-destructive"
                onClick={() => void handleDelete(addr.id)}
                disabled={deletingId === addr.id}
                aria-label="Usuń adres"
              >
                {deletingId === addr.id ? <Spinner className="h-3.5 w-3.5" /> : <Trash2 className="h-3.5 w-3.5" />}
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

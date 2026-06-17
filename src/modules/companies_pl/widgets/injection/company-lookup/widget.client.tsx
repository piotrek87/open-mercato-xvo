'use client'

import * as React from 'react'
import type { InjectionWidgetComponentProps } from '@open-mercato/shared/modules/widgets/injection'
import { InlineTextEditor } from '@open-mercato/ui/backend/detail'
import { Button } from '@open-mercato/ui/primitives/button'
import { Input } from '@open-mercato/ui/primitives/input'
import { Label } from '@open-mercato/ui/primitives/label'
import { Spinner } from '@open-mercato/ui/primitives/spinner'
import { useRouter } from 'next/navigation'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { parsePolishAddress } from '../../../lib/parsePolishAddress'

type CompanyOverview = {
  company?: {
    id: string
    displayName?: string
    organizationId?: string | null
    tenantId?: string | null
  }
  profile?: { id?: string; legalName?: string | null } | null
  customFields?: Record<string, unknown>
}

type FormValues = Record<string, unknown> & { displayName?: string; nip?: string; krs?: string; regon?: string }

function getCustomFieldsValue(customFields: unknown, key: string): string {
  if (!customFields || typeof customFields !== 'object') return ''
  const cf = customFields as Record<string, unknown>
  const val = cf[key] ?? cf[`cf_${key}`]
  return typeof val === 'string' ? val : ''
}

function getValue(source: Record<string, unknown>, key: 'nip' | 'krs' | 'regon'): string {
  const direct = source[key] ?? source[`cf_${key}`]
  if (typeof direct === 'string') return direct
  if (source.customFields && typeof source.customFields === 'object') {
    return getCustomFieldsValue(source.customFields, key)
  }
  return ''
}

function isDetailContext(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false
  const d = data as Record<string, unknown>
  return typeof d.customFields === 'object' && d.customFields !== null
}

function setField(
  source: Record<string, unknown>,
  key: 'nip' | 'krs' | 'regon',
  value: string,
  onDataChange: (next: Record<string, unknown>) => void,
  isDetail: boolean,
) {
  if (isDetail) {
    const overview = source as CompanyOverview
    const nextCustomFields = {
      ...overview.customFields,
      [`cf_${key}`]: value || null,
    }
    onDataChange({ ...overview, customFields: nextCustomFields })
  } else {
    const next = {
      ...source,
      [key]: value,
      [`cf_${key}`]: value,
    }
    onDataChange(next)
  }
}

const EMPTY_LABEL = '—'

export default function CompanyLookupWidget({
  context,
  data,
  onDataChange,
  disabled,
}: InjectionWidgetComponentProps<{ companyId?: string | null; data?: unknown; formId?: string }, unknown>) {
  const router = useRouter()
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [addressMessage, setAddressMessage] = React.useState<string | null>(null)
  const [pendingAddresses, setPendingAddresses] = React.useState<{
    residenceAddress?: string
    workingAddress?: string
    companyId: string
  } | null>(null)

  const source = (data ?? context?.data) as FormValues | CompanyOverview | undefined
  const isDetail = source ? isDetailContext(source) : false
  const companyId = isDetail && source ? (source as CompanyOverview).company?.id : null
  const isCreateWithAddresses =
    !isDetail && pendingAddresses && (pendingAddresses.residenceAddress || pendingAddresses.workingAddress)

  React.useEffect(() => {
    if (isDetail && pendingAddresses && pendingAddresses.companyId !== companyId) setPendingAddresses(null)
  }, [isDetail, companyId, pendingAddresses])

  const nip = source ? getValue(source as Record<string, unknown>, 'nip') : ''
  const krs = source ? getValue(source as Record<string, unknown>, 'krs') : ''
  const regon = source ? getValue(source as Record<string, unknown>, 'regon') : ''

  const normalizeNip = (v: string) => v.replace(/\D/g, '').slice(0, 10)
  const normalizeKrs = (v: string) => v.replace(/\D/g, '').slice(0, 10)
  const normalizeRegon = (v: string) => v.replace(/\D/g, '').slice(0, 14)
  const isValidRegon = (v: string) => v.length === 0 || v.length === 9 || v.length === 14

  const handleSaveNip = React.useCallback(
    async (value: string | null) => {
      if (!source || !onDataChange) return
      const norm = normalizeNip(value ?? '')
      if (norm && norm.length !== 10) { setError('NIP musi mieć 10 cyfr.'); return }
      setError(null)
      setField(source as Record<string, unknown>, 'nip', norm, onDataChange as (next: Record<string, unknown>) => void, isDetail)
    },
    [source, onDataChange, isDetail],
  )

  const handleSaveKrs = React.useCallback(
    async (value: string | null) => {
      if (!source || !onDataChange) return
      const norm = normalizeKrs(value ?? '')
      if (norm && norm.length !== 10) { setError('KRS musi mieć 10 cyfr.'); return }
      setError(null)
      setField(source as Record<string, unknown>, 'krs', norm, onDataChange as (next: Record<string, unknown>) => void, isDetail)
    },
    [source, onDataChange, isDetail],
  )

  const handleSaveRegon = React.useCallback(
    async (value: string | null) => {
      if (!source || !onDataChange) return
      const norm = normalizeRegon(value ?? '')
      if (norm && !isValidRegon(norm)) { setError('REGON musi mieć 9 lub 14 cyfr.'); return }
      setError(null)
      setField(source as Record<string, unknown>, 'regon', norm, onDataChange as (next: Record<string, unknown>) => void, isDetail)
    },
    [source, onDataChange, isDetail],
  )

  const handleFetch = React.useCallback(async () => {
    const nipToUse = nip.replace(/\D/g, '').slice(0, 10)
    if (nipToUse.length !== 10) { setError('NIP musi mieć 10 cyfr.'); return }
    setError(null)
    setLoading(true)
    try {
      // Adaptation: raw fetch() → apiCall (project convention)
      const { ok, result: lookupResult, response } = await apiCall<{
        nip?: string
        krs?: string
        regon?: string
        name?: string
        legalName?: string
        residenceAddress?: string
        workingAddress?: string
        error?: string
      }>(`/api/companies_pl/company-lookup?nip=${encodeURIComponent(nipToUse)}`)

      if (!ok) {
        const errMsg = (lookupResult as { error?: string } | undefined)?.error ?? `HTTP ${response?.status}`
        throw new Error(errMsg)
      }
      const result = lookupResult ?? {}

      if (!source || !onDataChange) return

      if (isDetail) {
        const overview = source as CompanyOverview
        const nextCustomFields = {
          ...overview.customFields,
          ...(result.nip != null && { cf_nip: String(result.nip) }),
          ...(result.krs != null && { cf_krs: String(result.krs) }),
          ...(result.regon != null && { cf_regon: String(result.regon) }),
        }
        const next: CompanyOverview = { ...overview, customFields: nextCustomFields }
        if (result.name?.trim()) {
          next.company = { ...(overview.company ?? {}), id: overview.company?.id ?? '', displayName: result.name.trim() }
        }
        if (result.legalName?.trim()) {
          next.profile = next.profile ? { ...next.profile, legalName: result.legalName.trim() } : { legalName: result.legalName.trim() }
        }
        onDataChange(next)

        const cid = overview.company?.id
        if (cid && (result.name?.trim() || result.legalName?.trim())) {
          const patch: Record<string, string> = {}
          if (result.name?.trim()) patch.displayName = result.name.trim()
          if (result.legalName?.trim()) patch.legalName = result.legalName.trim()
          // Adaptation: raw fetch() → apiCall
          const { ok: saveOk, result: saveResult } = await apiCall('/api/customers/companies', {
            method: 'PUT',
            body: JSON.stringify({ id: cid, ...patch }),
          })
          if (!saveOk) {
            const errBody = saveResult as { error?: string } | undefined
            setError(errBody?.error ?? 'Nie udało się zapisać nazwy firmy.')
          }
        }

        if (cid && (result.residenceAddress?.trim() || result.workingAddress?.trim())) {
          setPendingAddresses({
            companyId: cid,
            ...(result.residenceAddress?.trim() && { residenceAddress: result.residenceAddress.trim() }),
            ...(result.workingAddress?.trim() && { workingAddress: result.workingAddress.trim() }),
          })
        } else {
          setPendingAddresses(null)
        }
        setAddressMessage(null)
        return
      }

      const formData = source as FormValues
      const next: FormValues = {
        ...formData,
        ...(result.nip != null && { nip: String(result.nip), cf_nip: String(result.nip) }),
        ...(result.krs != null && { krs: String(result.krs), cf_krs: String(result.krs) }),
        ...(result.regon != null && { regon: String(result.regon), cf_regon: String(result.regon) }),
      }
      const name = result.name ?? result.legalName
      if (typeof name === 'string' && name.trim() && (formData.displayName == null || String(formData.displayName).trim() === '')) {
        next.displayName = name.trim()
      }
      onDataChange(next)
      if (result.residenceAddress?.trim() || result.workingAddress?.trim()) {
        setPendingAddresses({
          companyId: '',
          ...(result.residenceAddress?.trim() && { residenceAddress: result.residenceAddress.trim() }),
          ...(result.workingAddress?.trim() && { workingAddress: result.workingAddress.trim() }),
        })
      } else {
        setPendingAddresses(null)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Nie udało się pobrać danych.')
    } finally {
      setLoading(false)
    }
  }, [nip, source, onDataChange, isDetail])

  const [addingAddress, setAddingAddress] = React.useState<'residence' | 'working' | null>(null)
  const companyScope =
    isDetail && source && (source as CompanyOverview).company
      ? {
          organizationId: (source as CompanyOverview).company?.organizationId,
          tenantId: (source as CompanyOverview).company?.tenantId,
        }
      : null

  const addAddressToTab = React.useCallback(
    async (kind: 'residence' | 'working') => {
      if (!pendingAddresses) return
      const rawAddress = kind === 'residence' ? pendingAddresses.residenceAddress : pendingAddresses.workingAddress
      if (!rawAddress) return
      setAddingAddress(kind)
      setAddressMessage(null)
      const parsed = parsePolishAddress(rawAddress, 'PL')
      const name = kind === 'residence' ? 'Siedziba (z rejestru WL)' : 'Adres rejestracyjny (z rejestru WL)'

      if (!pendingAddresses.companyId && source && onDataChange) {
        const formValues = source as Record<string, unknown> & { addresses?: Array<Record<string, unknown>> }
        const prevAddresses = Array.isArray(formValues.addresses) ? formValues.addresses : []
        const newEntry = {
          id: `wl_${kind}_${prevAddresses.length}`,
          name,
          addressLine1: parsed.addressLine1.slice(0, 300),
          addressLine2: parsed.addressLine2 ?? undefined,
          buildingNumber: parsed.buildingNumber ?? undefined,
          city: parsed.city ?? undefined,
          postalCode: parsed.postalCode ?? undefined,
          country: parsed.country,
          isPrimary: prevAddresses.length === 0,
        }
        onDataChange({ ...formValues, addresses: [...prevAddresses, newEntry] })
        setPendingAddresses((prev) => {
          if (!prev) return null
          const next = { ...prev }
          if (kind === 'residence') delete next.residenceAddress
          else delete next.workingAddress
          if (!next.residenceAddress && !next.workingAddress) return null
          return next
        })
        setAddressMessage('Adres dodany do formularza. Zostanie zapisany przy tworzeniu firmy.')
        setAddingAddress(null)
        return
      }

      const body: Record<string, unknown> = {
        entityId: pendingAddresses.companyId,
        addressLine1: parsed.addressLine1.slice(0, 300),
        country: parsed.country,
        name,
      }
      if (parsed.buildingNumber) body.buildingNumber = parsed.buildingNumber.slice(0, 50)
      if (parsed.city) body.city = parsed.city.slice(0, 150)
      if (parsed.postalCode) body.postalCode = parsed.postalCode.slice(0, 30)
      if (companyScope?.organizationId) body.organizationId = companyScope.organizationId
      if (companyScope?.tenantId) body.tenantId = companyScope.tenantId

      try {
        // Adaptation: raw fetch() → apiCall
        const { ok, result: addrResult } = await apiCall('/api/customers/addresses', {
          method: 'POST',
          body: JSON.stringify(body),
        })
        if (!ok) {
          const errBody = addrResult as { error?: string } | undefined
          throw new Error(errBody?.error ?? `HTTP error`)
        }
        setPendingAddresses((prev) => {
          if (!prev) return null
          const next = { ...prev }
          if (kind === 'residence') delete next.residenceAddress
          else delete next.workingAddress
          if (!next.residenceAddress && !next.workingAddress) return null
          return next
        })
        setAddressMessage('Adres zapisany w systemie.')
        const onAddressAdded = (context as { onAddressAdded?: () => void })?.onAddressAdded
        if (typeof onAddressAdded === 'function') onAddressAdded()
        router.refresh()
      } catch (e) {
        setAddressMessage(e instanceof Error ? e.message : 'Nie udało się dodać adresu.')
      } finally {
        setAddingAddress(null)
      }
    },
    [pendingAddresses, companyScope, source, onDataChange, context],
  )

  const handleFieldChange = React.useCallback(
    (key: 'nip' | 'krs' | 'regon') => (e: React.ChangeEvent<HTMLInputElement>) => {
      if (!source || !onDataChange) return
      const normalized =
        key === 'nip' ? normalizeNip(e.target.value)
        : key === 'krs' ? normalizeKrs(e.target.value)
        : normalizeRegon(e.target.value)
      setError(null)
      setField(source as Record<string, unknown>, key, normalized, onDataChange as (next: Record<string, unknown>) => void, isDetail)
    },
    [source, onDataChange, isDetail],
  )

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold">Dane z rejestru (NIP/KRS/REGON)</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {isDetail
            ? 'Wpisz NIP i kliknij przycisk, aby pobrać KRS i REGON z API WL. Pola zapisują się w danych firmy. Edycja po kliknięciu w pole.'
            : 'Wpisz NIP i kliknij przycisk, aby pobrać KRS i REGON z API WL. Wartości zapiszą się razem z formularzem.'}
        </p>
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        {isDetail ? (
          <>
            <InlineTextEditor
              label="NIP"
              value={nip || null}
              placeholder="np. 6492310889"
              emptyLabel={EMPTY_LABEL}
              onSave={handleSaveNip}
              activateOnClick={!disabled}
              recordId={undefined}
            />
            <InlineTextEditor
              label="KRS"
              value={krs || null}
              placeholder="10 cyfr"
              emptyLabel={EMPTY_LABEL}
              onSave={handleSaveKrs}
              activateOnClick={!disabled}
              recordId={undefined}
            />
            <InlineTextEditor
              label="REGON"
              value={regon || null}
              placeholder="9 lub 14 cyfr"
              emptyLabel={EMPTY_LABEL}
              onSave={handleSaveRegon}
              activateOnClick={!disabled}
              recordId={undefined}
            />
          </>
        ) : (
          <>
            <div className="space-y-1.5">
              <Label htmlFor="companies-pl-nip">NIP</Label>
              <Input
                id="companies-pl-nip"
                type="text"
                inputMode="numeric"
                placeholder="np. 6492310889"
                value={nip}
                onChange={handleFieldChange('nip')}
                disabled={disabled}
                maxLength={13}
                className="font-mono"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="companies-pl-krs">KRS</Label>
              <Input
                id="companies-pl-krs"
                type="text"
                inputMode="numeric"
                placeholder="10 cyfr"
                value={krs}
                onChange={handleFieldChange('krs')}
                disabled={disabled}
                maxLength={10}
                className="font-mono"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="companies-pl-regon">REGON</Label>
              <Input
                id="companies-pl-regon"
                type="text"
                inputMode="numeric"
                placeholder="9 lub 14 cyfr"
                value={regon}
                onChange={handleFieldChange('regon')}
                disabled={disabled}
                maxLength={14}
                className="font-mono"
              />
            </div>
          </>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={handleFetch}
          disabled={disabled || loading}
        >
          {loading ? (
            <>
              <Spinner className="mr-1.5 h-3.5 w-3.5" />
              Pobieranie…
            </>
          ) : (
            'Pobierz dane po NIP'
          )}
        </Button>
      </div>
      {((pendingAddresses?.companyId && pendingAddresses.companyId === companyId) || isCreateWithAddresses) &&
        (pendingAddresses?.residenceAddress || pendingAddresses?.workingAddress) && (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            {pendingAddresses?.residenceAddress && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={disabled || addingAddress !== null}
                onClick={() => addAddressToTab('residence')}
              >
                {addingAddress === 'residence' ? <Spinner className="mr-1.5 h-3 w-3" /> : null}
                {'Zapisz adres siedziby'}
              </Button>
            )}
            {pendingAddresses?.workingAddress && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={disabled || addingAddress !== null}
                onClick={() => addAddressToTab('working')}
              >
                {addingAddress === 'working' ? <Spinner className="mr-1.5 h-3 w-3" /> : null}
                {'Zapisz adres rejestracyjny'}
              </Button>
            )}
          </div>
        )}
      {addressMessage && <p className="text-muted-foreground text-xs">{addressMessage}</p>}
      {error && <p className="text-destructive text-xs">{error}</p>}
    </div>
  )
}

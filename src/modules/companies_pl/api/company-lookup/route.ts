import { NextResponse } from 'next/server'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'

export const metadata = {
  GET: { requireAuth: true },
}

export const openApi = {
  GET: {
    summary: 'Pobierz dane firmy po NIP z rejestru WL MF',
    tags: ['companies_pl'],
    parameters: [{ name: 'nip', in: 'query', required: true, schema: { type: 'string' } }],
  },
}

const WL_API_BASE = 'https://wl-api.mf.gov.pl'

type WlSubject = {
  name?: string
  nip?: string
  regon?: string
  krs?: string
  residenceAddress?: string
  workingAddress?: string
  statusVat?: string
}

type WlEntityResponse = {
  result?: {
    subject?: WlSubject
    requestDateTime?: string
    requestId?: string
  }
}

export async function GET(req: Request) {
  const auth = await getAuthFromRequest(req)
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const url = new URL(req.url)
  const rawNip = url.searchParams.get('nip') ?? ''
  const nip = rawNip.replace(/\D/g, '').slice(0, 10)
  if (nip.length !== 10) {
    return NextResponse.json({ error: 'Podaj poprawny NIP (10 cyfr).' }, { status: 400 })
  }

  const customApiUrl = process.env.OM_COMPANY_LOOKUP_API_URL?.trim()
  if (customApiUrl) {
    try {
      const target = customApiUrl.includes('?')
        ? `${customApiUrl.replace(/\?$/, '')}&nip=${encodeURIComponent(nip)}`
        : `${customApiUrl}?nip=${encodeURIComponent(nip)}`
      const res = await fetch(target, { method: 'GET', headers: { Accept: 'application/json' } })
      if (!res.ok) {
        const text = await res.text()
        return NextResponse.json(
          { error: `Zewnętrzne API zwróciło ${res.status}: ${text.slice(0, 200)}` },
          { status: 502 },
        )
      }
      const data = (await res.json()) as Record<string, unknown>
      const out: Record<string, string> = {}
      if (data.nip != null) out.nip = String(data.nip)
      if (data.krs != null) out.krs = String(data.krs)
      if (data.regon != null) out.regon = String(data.regon)
      if (data.name != null) out.name = String(data.name)
      if (data.legalName != null) out.legalName = String(data.legalName)
      return NextResponse.json(out)
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Błąd połączenia z API'
      return NextResponse.json({ error: message }, { status: 502 })
    }
  }

  const useWlApi = process.env.OM_USE_WL_API !== 'false'
  if (useWlApi) {
    const date = new Date().toISOString().slice(0, 10)
    const wlUrl = `${WL_API_BASE}/api/search/nip/${encodeURIComponent(nip)}?date=${date}`
    try {
      const res = await fetch(wlUrl, { method: 'GET', headers: { Accept: 'application/json' } })
      if (!res.ok) {
        const text = await res.text()
        return NextResponse.json(
          { error: `API WL (MF) zwróciło ${res.status}. ${text.slice(0, 150)}` },
          { status: res.status >= 500 ? 502 : 400 },
        )
      }
      const data = (await res.json()) as WlEntityResponse
      const subject = data?.result?.subject
      if (!subject) {
        return NextResponse.json({ error: 'Brak danych podmiotu w odpowiedzi API WL.' }, { status: 404 })
      }
      const out: Record<string, string> = {}
      if (subject.nip?.trim()) out.nip = subject.nip.trim()
      if (subject.krs?.trim()) out.krs = subject.krs.trim()
      if (subject.regon?.trim()) out.regon = subject.regon.trim()
      if (subject.name?.trim()) { out.name = subject.name.trim(); out.legalName = out.name }
      if (subject.residenceAddress?.trim()) out.residenceAddress = subject.residenceAddress.trim()
      if (subject.workingAddress?.trim()) out.workingAddress = subject.workingAddress.trim()
      if (subject.statusVat?.trim()) out.statusVat = subject.statusVat.trim()
      return NextResponse.json(out)
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Błąd połączenia z API WL'
      return NextResponse.json({ error: message }, { status: 502 })
    }
  }

  // Mock fallback gdy OM_USE_WL_API=false (dev bez dostępu do MF)
  const nipFormatted = `${nip.slice(0, 3)}-${nip.slice(3, 6)}-${nip.slice(6, 8)}-${nip.slice(8, 10)}`
  return NextResponse.json({
    nip: nipFormatted,
    krs: '0000123456',
    regon: nip.slice(0, 9),
    name: `Firma mock (NIP ${nipFormatted})`,
    legalName: `Firma mock (NIP ${nipFormatted})`,
  })
}

export type ParsedPolishAddress = {
  addressLine1: string
  addressLine2?: string | null
  buildingNumber?: string | null
  city?: string | null
  postalCode?: string | null
  country: string
}

const POSTAL_CODE_REGEX = /\b(\d{2}-\d{3})\b/
const BUILDING_NUMBER_REGEX = /\s+(\d+[A-Za-z]?)\s*,?\s*$/

export function parsePolishAddress(raw: string, defaultCountry = 'PL'): ParsedPolishAddress {
  const trimmed = raw.trim().slice(0, 500)
  if (!trimmed) {
    return { addressLine1: '', country: defaultCountry }
  }

  const postalMatch = trimmed.match(POSTAL_CODE_REGEX)
  let postalCode: string | null = null
  let city: string | null = null
  let beforePostal = trimmed
  let afterPostal = ''

  if (postalMatch && postalMatch.index !== undefined) {
    postalCode = postalMatch[1]
    beforePostal = trimmed.slice(0, postalMatch.index).trim().replace(/\s*,\s*$/, '')
    afterPostal = trimmed.slice(postalMatch.index + postalMatch[0].length).trim().replace(/^,?\s*/, '')
    const cityPart = afterPostal.split(',')[0].trim()
    city = cityPart || null
  }

  let addressLine1 = beforePostal
  let buildingNumber: string | null = null
  const numberMatch = beforePostal.match(BUILDING_NUMBER_REGEX)
  if (numberMatch) {
    buildingNumber = numberMatch[1]
    addressLine1 = beforePostal.slice(0, numberMatch.index).trim().replace(/\s*,\s*$/, '')
  }

  if (!addressLine1 && beforePostal) addressLine1 = beforePostal

  return {
    addressLine1: addressLine1 || trimmed,
    buildingNumber: buildingNumber || null,
    city: city || null,
    postalCode: postalCode || null,
    country: defaultCountry,
  }
}

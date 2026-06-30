import { parsePolishAddress } from '../lib/parsePolishAddress'

describe('parsePolishAddress', () => {
  it('parses a full street + building + postal + city address', () => {
    const r = parsePolishAddress('ul. Bakalarska 34, 02-212 Warszawa')
    expect(r).toEqual({
      addressLine1: 'ul. Bakalarska',
      buildingNumber: '34',
      city: 'Warszawa',
      postalCode: '02-212',
      country: 'PL',
    })
  })

  it('keeps an alphanumeric building number (e.g. 12A)', () => {
    const r = parsePolishAddress('Marszałkowska 12A, 00-001 Warszawa')
    expect(r.buildingNumber).toBe('12A')
    expect(r.addressLine1).toBe('Marszałkowska')
    expect(r.postalCode).toBe('00-001')
    expect(r.city).toBe('Warszawa')
  })

  it('handles an address with no building number', () => {
    const r = parsePolishAddress('Rynek, 31-001 Kraków')
    expect(r.addressLine1).toBe('Rynek')
    expect(r.buildingNumber).toBeNull()
    expect(r.postalCode).toBe('31-001')
    expect(r.city).toBe('Kraków')
  })

  it('handles an address with no postal code', () => {
    const r = parsePolishAddress('ul. Testowa 5')
    expect(r.addressLine1).toBe('ul. Testowa')
    expect(r.buildingNumber).toBe('5')
    expect(r.postalCode).toBeNull()
    expect(r.city).toBeNull()
  })

  it('returns empty addressLine1 for blank input', () => {
    const r = parsePolishAddress('   ')
    expect(r.addressLine1).toBe('')
    expect(r.country).toBe('PL')
  })

  it('honors a custom default country', () => {
    const r = parsePolishAddress('Hauptstraße 1, 10115 Berlin', 'DE')
    expect(r.country).toBe('DE')
  })

  it('truncates very long input to 500 chars before parsing', () => {
    const longStreet = 'a'.repeat(600)
    const r = parsePolishAddress(longStreet)
    expect(r.addressLine1.length).toBeLessThanOrEqual(500)
  })
})

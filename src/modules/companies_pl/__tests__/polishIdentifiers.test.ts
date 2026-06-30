import { isValidNip, isValidRegon, isValidKrs } from '../lib/polishIdentifiers'

describe('isValidNip', () => {
  it('accepts a valid NIP (checksum)', () => {
    expect(isValidNip('5260001246')).toBe(true)
  })
  it('accepts formatted NIP with separators', () => {
    expect(isValidNip('526-000-12-46')).toBe(true)
  })
  it('rejects a wrong checksum', () => {
    expect(isValidNip('5260001247')).toBe(false)
  })
  it('rejects wrong length / non-digits', () => {
    expect(isValidNip('123')).toBe(false)
    expect(isValidNip('abcdefghij')).toBe(false)
    expect(isValidNip('')).toBe(false)
  })
})

describe('isValidRegon', () => {
  it('accepts a valid 9-digit REGON', () => {
    expect(isValidRegon('123456785')).toBe(true)
  })
  it('rejects a wrong 9-digit checksum', () => {
    expect(isValidRegon('123456789')).toBe(false)
  })
  it('rejects wrong length', () => {
    expect(isValidRegon('12345')).toBe(false)
    expect(isValidRegon('1234567890123')).toBe(false) // 13 digits
  })
})

describe('isValidKrs', () => {
  it('accepts 10 digits (no checksum)', () => {
    expect(isValidKrs('0000123456')).toBe(true)
  })
  it('rejects wrong length', () => {
    expect(isValidKrs('123')).toBe(false)
    expect(isValidKrs('00001234567')).toBe(false)
  })
})

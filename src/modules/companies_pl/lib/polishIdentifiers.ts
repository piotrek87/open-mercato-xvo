/**
 * Checksum validation for Polish business identifiers. Reject malformed-but-well-formed numbers
 * before hitting the external API.
 *
 * - NIP: 10 digits, mod-11 weighted checksum.
 * - REGON: 9 or 14 digits, mod-11 weighted checksum (the 14-digit form embeds a valid 9-digit core).
 * - KRS: 10 digits — the registry number has NO official checksum, so we validate format only.
 */

function digits(raw: string): string {
  return (raw ?? '').replace(/[\s-]/g, '')
}

export function isValidNip(raw: string): boolean {
  const nip = digits(raw)
  if (!/^\d{10}$/.test(nip)) return false
  const weights = [6, 5, 7, 2, 3, 4, 5, 6, 7]
  const sum = weights.reduce((acc, w, i) => acc + w * Number(nip[i]), 0)
  const check = sum % 11
  if (check === 10) return false
  return check === Number(nip[9])
}

function regonCheck(value: string, weights: number[]): boolean {
  const sum = weights.reduce((acc, w, i) => acc + w * Number(value[i]), 0)
  let check = sum % 11
  if (check === 10) check = 0
  return check === Number(value[weights.length])
}

export function isValidRegon(raw: string): boolean {
  const regon = digits(raw)
  if (/^\d{9}$/.test(regon)) {
    return regonCheck(regon, [8, 9, 2, 3, 4, 5, 6, 7])
  }
  if (/^\d{14}$/.test(regon)) {
    // The 14-digit (local unit) REGON embeds a valid 9-digit (parent) REGON.
    return isValidRegon(regon.slice(0, 9)) && regonCheck(regon, [2, 4, 8, 5, 0, 9, 7, 3, 6, 1, 2, 4, 8])
  }
  return false
}

export function isValidKrs(raw: string): boolean {
  // KRS is a 10-digit sequential number with no checksum algorithm — validate length/shape only.
  return /^\d{10}$/.test(digits(raw))
}

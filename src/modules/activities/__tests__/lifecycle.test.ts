/**
 * Lifecycle state machine unit tests.
 *
 * These helpers mirror the guard logic in the route handlers:
 *   - complete/route.ts:  blocks if status === 'completed' || status === 'cancelled'
 *   - cancel/route.ts:    blocks if status === 'cancelled'
 *   - reopen/route.ts:    blocks if status !== 'completed' && status !== 'cancelled'
 *   - restore/route.ts:   operates on soft-deleted records (deletedAt !== null)
 */

// --- Pure helpers that reflect the route-handler business rules ---

function canComplete(status: string): boolean {
  return status !== 'completed' && status !== 'cancelled'
}

function canCancel(status: string): boolean {
  return status !== 'cancelled'
}

function canReopen(status: string): boolean {
  return status === 'completed' || status === 'cancelled'
}

function canRestore(deletedAt: Date | null | undefined): boolean {
  return deletedAt !== null && deletedAt !== undefined
}

// --- Tests ---

describe('canComplete', () => {
  it('1. not_started → can complete', () => {
    expect(canComplete('not_started')).toBe(true)
  })

  it('2. in_progress → can complete', () => {
    expect(canComplete('in_progress')).toBe(true)
  })

  it('3. completed → cannot complete again', () => {
    expect(canComplete('completed')).toBe(false)
  })

  it('4. cancelled → cannot complete', () => {
    expect(canComplete('cancelled')).toBe(false)
  })
})

describe('canCancel', () => {
  it('5. not_started → can cancel', () => {
    expect(canCancel('not_started')).toBe(true)
  })

  it('6. completed → can cancel', () => {
    expect(canCancel('completed')).toBe(true)
  })

  it('7. cancelled → cannot cancel again', () => {
    expect(canCancel('cancelled')).toBe(false)
  })
})

describe('canReopen', () => {
  it('8. completed → can reopen', () => {
    expect(canReopen('completed')).toBe(true)
  })

  it('9. cancelled → can reopen', () => {
    expect(canReopen('cancelled')).toBe(true)
  })

  it('10. not_started → cannot reopen (not in terminal state)', () => {
    expect(canReopen('not_started')).toBe(false)
  })

  it('11. in_progress → cannot reopen (not in terminal state)', () => {
    expect(canReopen('in_progress')).toBe(false)
  })
})

describe('canRestore', () => {
  it('12. deletedAt = Date → can restore (record is soft-deleted)', () => {
    expect(canRestore(new Date())).toBe(true)
  })

  it('13. deletedAt = null → cannot restore (record is not deleted)', () => {
    expect(canRestore(null)).toBe(false)
  })

  it('14. deletedAt = undefined → cannot restore (record is not deleted)', () => {
    expect(canRestore(undefined)).toBe(false)
  })
})

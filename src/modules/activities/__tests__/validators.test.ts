import {
  activityCreateSchema,
  activityUpdateSchema,
  activityCompleteSchema,
  activityCancelSchema,
} from '../data/validators'

describe('activityCreateSchema', () => {
  it('1. valid task activity creation', () => {
    const result = activityCreateSchema.safeParse({
      lifecycleMode: 'task',
      activityType: 'task',
      subject: 'Test task',
    })
    expect(result.success).toBe(true)
  })

  it('2. valid fact activity creation with occurredAt', () => {
    const result = activityCreateSchema.safeParse({
      lifecycleMode: 'fact',
      activityType: 'call',
      subject: 'Call with client',
      occurredAt: '2026-06-15T10:00:00+00:00',
    })
    expect(result.success).toBe(true)
  })

  it('3. linkedEntityType without linkedEntityId should fail', () => {
    const result = activityCreateSchema.safeParse({
      lifecycleMode: 'task',
      activityType: 'task',
      subject: 'Test',
      linkedEntityType: 'customer',
    })
    expect(result.success).toBe(false)
  })

  it('4. linkedEntityId without linkedEntityType should fail', () => {
    const result = activityCreateSchema.safeParse({
      lifecycleMode: 'task',
      activityType: 'task',
      subject: 'Test',
      linkedEntityId: '550e8400-e29b-41d4-a716-446655440000',
    })
    expect(result.success).toBe(false)
  })

  it('5. externalId without externalProvider should fail', () => {
    const result = activityCreateSchema.safeParse({
      lifecycleMode: 'task',
      activityType: 'task',
      subject: 'Test',
      externalId: 'ext-123',
    })
    expect(result.success).toBe(false)
  })

  it('6. visibility private with lifecycleMode fact should fail', () => {
    const result = activityCreateSchema.safeParse({
      lifecycleMode: 'fact',
      activityType: 'call',
      subject: 'Test',
      visibility: 'private',
    })
    expect(result.success).toBe(false)
  })

  it('7. missing required subject should fail', () => {
    const result = activityCreateSchema.safeParse({
      lifecycleMode: 'task',
      activityType: 'task',
    })
    expect(result.success).toBe(false)
  })

  it('8. missing required activityType should fail', () => {
    const result = activityCreateSchema.safeParse({
      lifecycleMode: 'task',
      subject: 'Test',
    })
    expect(result.success).toBe(false)
  })

  it('9. missing required lifecycleMode should fail', () => {
    const result = activityCreateSchema.safeParse({
      activityType: 'task',
      subject: 'Test',
    })
    expect(result.success).toBe(false)
  })

  it('10. priority below 0 should fail', () => {
    const result = activityCreateSchema.safeParse({
      lifecycleMode: 'task',
      activityType: 'task',
      subject: 'Test',
      priority: -1,
    })
    expect(result.success).toBe(false)
  })

  it('10b. priority above 100 should fail', () => {
    const result = activityCreateSchema.safeParse({
      lifecycleMode: 'task',
      activityType: 'task',
      subject: 'Test',
      priority: 101,
    })
    expect(result.success).toBe(false)
  })

  it('11. durationMinutes above 1440 should fail', () => {
    const result = activityCreateSchema.safeParse({
      lifecycleMode: 'task',
      activityType: 'task',
      subject: 'Test',
      durationMinutes: 1441,
    })
    expect(result.success).toBe(false)
  })

  it('11b. durationMinutes below 0 should fail', () => {
    const result = activityCreateSchema.safeParse({
      lifecycleMode: 'task',
      activityType: 'task',
      subject: 'Test',
      durationMinutes: -1,
    })
    expect(result.success).toBe(false)
  })
})

describe('activityUpdateSchema', () => {
  it('12. valid partial update with only subject changed', () => {
    const result = activityUpdateSchema.safeParse({
      id: '550e8400-e29b-41d4-a716-446655440000',
      subject: 'Updated subject',
    })
    expect(result.success).toBe(true)
  })

  it('13. schema does not include lifecycleMode or activityType fields', () => {
    // Provide these immutable fields — the schema should not include them
    const result = activityUpdateSchema.safeParse({
      id: '550e8400-e29b-41d4-a716-446655440000',
      subject: 'Updated subject',
      lifecycleMode: 'task',
      activityType: 'call',
    })
    // safeParse should succeed (unknown keys are stripped by default in zod)
    expect(result.success).toBe(true)
    if (result.success) {
      // lifecycleMode and activityType should NOT appear in parsed output
      expect('lifecycleMode' in result.data).toBe(false)
      expect('activityType' in result.data).toBe(false)
    }
  })
})

describe('activityCompleteSchema', () => {
  it('14. empty body should parse successfully', () => {
    const result = activityCompleteSchema.safeParse({})
    expect(result.success).toBe(true)
  })

  it('15. valid occurredAt ISO string should parse', () => {
    const result = activityCompleteSchema.safeParse({
      occurredAt: '2026-06-15T14:30:00+00:00',
    })
    expect(result.success).toBe(true)
  })

  it('16. invalid occurredAt (not a date string) should fail', () => {
    const result = activityCompleteSchema.safeParse({
      occurredAt: 'not-a-date',
    })
    expect(result.success).toBe(false)
  })
})

describe('activityCancelSchema', () => {
  it('17. empty body should parse successfully (reason is optional)', () => {
    const result = activityCancelSchema.safeParse({})
    expect(result.success).toBe(true)
  })

  it('18. valid reason string should parse', () => {
    const result = activityCancelSchema.safeParse({
      reason: 'Customer cancelled the meeting',
    })
    expect(result.success).toBe(true)
  })
})

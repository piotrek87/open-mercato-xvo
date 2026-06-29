import { activityLinkCreateSchema, activityLinkUpdateSchema } from '../data/validators'
import { activityTypes, getAllActivityTypes, getActivityTypeById } from '../activity-types'

// ── ActivityLink validators ──────────────────────────────────────────────────

describe('activityLinkCreateSchema', () => {
  it('1. valid link with module:entity format', () => {
    const result = activityLinkCreateSchema.safeParse({
      entityType: 'customers:person',
      entityId: '550e8400-e29b-41d4-a716-446655440001',
    })
    expect(result.success).toBe(true)
    expect(result.data?.isPrimary).toBe(false) // default
  })

  it('2. valid link with isPrimary=true', () => {
    const result = activityLinkCreateSchema.safeParse({
      entityType: 'sales:order',
      entityId: '550e8400-e29b-41d4-a716-446655440002',
      isPrimary: true,
    })
    expect(result.success).toBe(true)
    expect(result.data?.isPrimary).toBe(true)
  })

  it('3. entityType without colon separator should fail', () => {
    const result = activityLinkCreateSchema.safeParse({
      entityType: 'customers_person',
      entityId: '550e8400-e29b-41d4-a716-446655440001',
    })
    expect(result.success).toBe(false)
  })

  it('4. entityType with uppercase should fail', () => {
    const result = activityLinkCreateSchema.safeParse({
      entityType: 'Customers:Person',
      entityId: '550e8400-e29b-41d4-a716-446655440001',
    })
    expect(result.success).toBe(false)
  })

  it('5. entityId not a UUID should fail', () => {
    const result = activityLinkCreateSchema.safeParse({
      entityType: 'customers:person',
      entityId: 'not-a-uuid',
    })
    expect(result.success).toBe(false)
  })

  it('6. missing entityId should fail', () => {
    const result = activityLinkCreateSchema.safeParse({
      entityType: 'customers:person',
    })
    expect(result.success).toBe(false)
  })

  it('7. missing entityType should fail', () => {
    const result = activityLinkCreateSchema.safeParse({
      entityId: '550e8400-e29b-41d4-a716-446655440001',
    })
    expect(result.success).toBe(false)
  })

  it('8. entityType too long (>100 chars) should fail', () => {
    const result = activityLinkCreateSchema.safeParse({
      entityType: `customers:${'x'.repeat(100)}`,
      entityId: '550e8400-e29b-41d4-a716-446655440001',
    })
    expect(result.success).toBe(false)
  })
})

describe('activityLinkUpdateSchema', () => {
  it('9. valid update with isPrimary=true', () => {
    const result = activityLinkUpdateSchema.safeParse({ isPrimary: true })
    expect(result.success).toBe(true)
  })

  it('10. valid update with isPrimary=false', () => {
    const result = activityLinkUpdateSchema.safeParse({ isPrimary: false })
    expect(result.success).toBe(true)
  })

  it('11. missing isPrimary should fail', () => {
    const result = activityLinkUpdateSchema.safeParse({})
    expect(result.success).toBe(false)
  })
})

// ── Activity type registry ───────────────────────────────────────────────────

describe('activity type registry (static)', () => {
  it('12. activityTypes exports 5 built-in types', () => {
    expect(activityTypes).toHaveLength(5)
  })

  it('13. all built-in types have required fields', () => {
    for (const type of activityTypes) {
      expect(type.id).toBeTruthy()
      expect(type.moduleId).toBe('activities')
      expect(type.label).toBeTruthy()
      expect(type.icon).toBeTruthy()
      expect(['fact', 'task']).toContain(type.lifecycleMode)
      expect(type.capabilities).toBeDefined()
    }
  })

  it('14. getAllActivityTypes returns all built-in types', () => {
    const all = getAllActivityTypes()
    expect(all).toHaveLength(5)
  })

  it('15. getActivityTypeById returns known type', () => {
    const email = getActivityTypeById('email')
    expect(email).toBeDefined()
    expect(email?.lifecycleMode).toBe('fact')
    expect(email?.capabilities.hasBody).toBe(true)
  })

  it('16. getActivityTypeById returns undefined for unknown id', () => {
    expect(getActivityTypeById('unknown:type')).toBeUndefined()
  })

  it('17. email type has correct capabilities', () => {
    const email = getActivityTypeById('email')
    expect(email?.capabilities.hasBody).toBe(true)
    expect(email?.capabilities.hasParticipants).toBe(true)
    expect(email?.capabilities.hasDueDate).toBeFalsy()
  })

  it('18. task type is task lifecycle mode', () => {
    const task = getActivityTypeById('task')
    expect(task?.lifecycleMode).toBe('task')
    expect(task?.capabilities.hasStatus).toBe(true)
    expect(task?.capabilities.hasOwner).toBe(true)
  })

  it('19. meeting has location and recurrence capabilities', () => {
    const meeting = getActivityTypeById('meeting')
    expect(meeting?.capabilities.hasLocation).toBe(true)
    expect(meeting?.capabilities.hasRecurrence).toBe(true)
    expect(meeting?.capabilities.hasParticipants).toBe(true)
  })

  it('20. all built-in type IDs are unique', () => {
    const ids = activityTypes.map((t) => t.id)
    const unique = new Set(ids)
    expect(unique.size).toBe(ids.length)
  })
})

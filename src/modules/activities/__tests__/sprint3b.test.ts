import {
  activityTypeDefinitionCreateSchema,
  activityTypeDefinitionUpdateSchema,
} from '../data/validators'
import { activityTypes, getAllActivityTypes, getActivityTypeById } from '../activity-types'

// ────────────────────────────────────────────────
// activityTypeDefinitionCreateSchema
// ────────────────────────────────────────────────

describe('activityTypeDefinitionCreateSchema', () => {
  it('1. valid custom type with required fields', () => {
    const result = activityTypeDefinitionCreateSchema.safeParse({
      typeId: 'custom:demo_call',
      label: 'Demo Call',
    })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.icon).toBe('Activity')
    expect(result.data.lifecycleMode).toBe('task')
    expect(result.data.isActive).toBe(true)
    expect(result.data.sortOrder).toBe(0)
    expect(result.data.capabilities).toEqual({})
  })

  it('2. valid type with all fields', () => {
    const result = activityTypeDefinitionCreateSchema.safeParse({
      typeId: 'custom:onboarding',
      label: 'Onboarding',
      icon: 'Users',
      color: '#3b82f6',
      lifecycleMode: 'fact',
      capabilities: { hasBody: true, hasParticipants: true },
      isActive: true,
      sortOrder: 5,
    })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.lifecycleMode).toBe('fact')
    expect(result.data.capabilities.hasBody).toBe(true)
    expect(result.data.capabilities.hasParticipants).toBe(true)
  })

  it('3. typeId without custom: prefix fails', () => {
    const result = activityTypeDefinitionCreateSchema.safeParse({
      typeId: 'demo_call',
      label: 'Demo Call',
    })
    expect(result.success).toBe(false)
  })

  it('4. typeId with uppercase letters fails', () => {
    const result = activityTypeDefinitionCreateSchema.safeParse({
      typeId: 'custom:DemoCall',
      label: 'Demo Call',
    })
    expect(result.success).toBe(false)
  })

  it('5. typeId with hyphens fails (only underscores allowed)', () => {
    const result = activityTypeDefinitionCreateSchema.safeParse({
      typeId: 'custom:demo-call',
      label: 'Demo Call',
    })
    expect(result.success).toBe(false)
  })

  it('6. typeId = "custom:" (empty suffix) fails', () => {
    const result = activityTypeDefinitionCreateSchema.safeParse({
      typeId: 'custom:',
      label: 'Demo Call',
    })
    expect(result.success).toBe(false)
  })

  it('7. empty label fails', () => {
    const result = activityTypeDefinitionCreateSchema.safeParse({
      typeId: 'custom:demo',
      label: '',
    })
    expect(result.success).toBe(false)
  })

  it('8. label too long fails', () => {
    const result = activityTypeDefinitionCreateSchema.safeParse({
      typeId: 'custom:demo',
      label: 'a'.repeat(201),
    })
    expect(result.success).toBe(false)
  })

  it('9. sortOrder out of range fails', () => {
    const result = activityTypeDefinitionCreateSchema.safeParse({
      typeId: 'custom:demo',
      label: 'Demo',
      sortOrder: 10000,
    })
    expect(result.success).toBe(false)
  })

  it('10. sortOrder = 0 is valid', () => {
    const result = activityTypeDefinitionCreateSchema.safeParse({
      typeId: 'custom:demo',
      label: 'Demo',
      sortOrder: 0,
    })
    expect(result.success).toBe(true)
  })

  it('11. sortOrder = 9999 is valid', () => {
    const result = activityTypeDefinitionCreateSchema.safeParse({
      typeId: 'custom:demo',
      label: 'Demo',
      sortOrder: 9999,
    })
    expect(result.success).toBe(true)
  })

  it('12. float sortOrder fails', () => {
    const result = activityTypeDefinitionCreateSchema.safeParse({
      typeId: 'custom:demo',
      label: 'Demo',
      sortOrder: 1.5,
    })
    expect(result.success).toBe(false)
  })

  it('13. invalid lifecycleMode fails', () => {
    const result = activityTypeDefinitionCreateSchema.safeParse({
      typeId: 'custom:demo',
      label: 'Demo',
      lifecycleMode: 'invalid',
    })
    expect(result.success).toBe(false)
  })

  it('14. unknown capability field is stripped (Zod strips unknowns)', () => {
    const result = activityTypeDefinitionCreateSchema.safeParse({
      typeId: 'custom:demo',
      label: 'Demo',
      capabilities: { hasBody: true, unknownCap: true },
    })
    // Zod strips unknown fields by default
    expect(result.success).toBe(true)
    if (!result.success) return
    expect((result.data.capabilities as Record<string, unknown>).unknownCap).toBeUndefined()
  })
})

// ────────────────────────────────────────────────
// activityTypeDefinitionUpdateSchema
// ────────────────────────────────────────────────

describe('activityTypeDefinitionUpdateSchema', () => {
  it('15. empty update is valid (all fields optional)', () => {
    const result = activityTypeDefinitionUpdateSchema.safeParse({})
    expect(result.success).toBe(true)
  })

  it('16. partial update — label only', () => {
    const result = activityTypeDefinitionUpdateSchema.safeParse({ label: 'Updated Label' })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.label).toBe('Updated Label')
    expect(result.data.icon).toBeUndefined()
  })

  it('17. isActive false is valid (soft-deactivate)', () => {
    const result = activityTypeDefinitionUpdateSchema.safeParse({ isActive: false })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.isActive).toBe(false)
  })

  it('18. color: null is valid (clear color)', () => {
    const result = activityTypeDefinitionUpdateSchema.safeParse({ color: null })
    expect(result.success).toBe(true)
  })

  it('19. label: empty string fails on update', () => {
    const result = activityTypeDefinitionUpdateSchema.safeParse({ label: '' })
    expect(result.success).toBe(false)
  })
})

// ────────────────────────────────────────────────
// L1 Registry — built-in type guard (L3 merge safety)
// ────────────────────────────────────────────────

describe('L1 built-in registry guard', () => {
  it('20. built-in type IDs are known and stable', () => {
    const builtIn = getAllActivityTypes().map((t) => t.id)
    expect(builtIn).toContain('email')
    expect(builtIn).toContain('meeting')
    expect(builtIn).toContain('call')
    expect(builtIn).toContain('note')
    expect(builtIn).toContain('task')
  })

  it('21. getActivityTypeById returns correct type', () => {
    const note = getActivityTypeById('note')
    expect(note).toBeDefined()
    expect(note?.lifecycleMode).toBe('fact')
    expect(note?.capabilities.hasBody).toBe(true)
  })

  it('22. custom: prefix never conflicts with built-in IDs', () => {
    const builtIn = getAllActivityTypes().map((t) => t.id)
    const customId = 'custom:test_type'
    expect(builtIn).not.toContain(customId)
  })

  it('23. built-in types all have defaultValues', () => {
    const types = getAllActivityTypes()
    for (const t of types) {
      expect(t.defaultValues).toBeDefined()
    }
  })

  it('24. fact-mode types do not set dueAt defaultValue', () => {
    const factTypes = activityTypes.filter((t) => t.lifecycleMode === 'fact')
    for (const t of factTypes) {
      expect(t.defaultValues?.dueAt).toBeUndefined()
    }
  })

  it('25. task-mode types do not set occurredAt defaultValue', () => {
    const taskTypes = activityTypes.filter((t) => t.lifecycleMode === 'task')
    for (const t of taskTypes) {
      expect(t.defaultValues?.occurredAt).toBeUndefined()
    }
  })
})

// ────────────────────────────────────────────────
// L3 merge logic (pure function unit tests)
// ────────────────────────────────────────────────

import type { ActivityTypeDefinition } from '../activity-types'

function mergeActivityTypes(
  builtIn: ActivityTypeDefinition[],
  l3: ActivityTypeDefinition[],
): { merged: ActivityTypeDefinition[]; collisions: string[] } {
  const builtInIds = new Set(builtIn.map((t) => t.id))
  const collisions: string[] = []
  const l3Filtered = l3.filter((t) => {
    if (builtInIds.has(t.id)) { collisions.push(t.id); return false }
    return true
  })
  return { merged: [...builtIn, ...l3Filtered], collisions }
}

describe('L3 merge logic', () => {
  const builtIn: ActivityTypeDefinition[] = [
    { id: 'email', moduleId: 'activities', label: 'Email', icon: 'Mail', lifecycleMode: 'fact', capabilities: {} },
    { id: 'note', moduleId: 'activities', label: 'Note', icon: 'FileText', lifecycleMode: 'fact', capabilities: {} },
  ]

  it('26. L3 type with unique ID is included in merged result', () => {
    const l3: ActivityTypeDefinition[] = [
      { id: 'custom:demo', moduleId: 'activities', label: 'Demo', icon: 'Activity', lifecycleMode: 'task', capabilities: {} },
    ]
    const { merged, collisions } = mergeActivityTypes(builtIn, l3)
    expect(merged).toHaveLength(3)
    expect(merged.map((t) => t.id)).toContain('custom:demo')
    expect(collisions).toHaveLength(0)
  })

  it('27. L3 type with built-in ID is excluded and collision recorded', () => {
    const l3: ActivityTypeDefinition[] = [
      { id: 'email', moduleId: 'activities', label: 'Override Email', icon: 'Mail', lifecycleMode: 'fact', capabilities: {} },
    ]
    const { merged, collisions } = mergeActivityTypes(builtIn, l3)
    expect(merged).toHaveLength(2)
    expect(collisions).toContain('email')
    // Only one 'email' in merged (the built-in)
    const emailTypes = merged.filter((t) => t.id === 'email')
    expect(emailTypes).toHaveLength(1)
    expect(emailTypes[0].label).toBe('Email') // built-in wins
  })

  it('28. multiple L3 types are all merged when no conflict', () => {
    const l3: ActivityTypeDefinition[] = [
      { id: 'custom:demo', moduleId: 'activities', label: 'Demo', icon: 'Activity', lifecycleMode: 'task', capabilities: {} },
      { id: 'custom:support', moduleId: 'activities', label: 'Support', icon: 'HelpCircle', lifecycleMode: 'task', capabilities: {} },
    ]
    const { merged, collisions } = mergeActivityTypes(builtIn, l3)
    expect(merged).toHaveLength(4)
    expect(collisions).toHaveLength(0)
  })

  it('29. empty L3 returns only built-in types', () => {
    const { merged, collisions } = mergeActivityTypes(builtIn, [])
    expect(merged).toHaveLength(2)
    expect(collisions).toHaveLength(0)
  })

  it('30. built-in types appear before L3 types in merged result', () => {
    const l3: ActivityTypeDefinition[] = [
      { id: 'custom:zzz', moduleId: 'activities', label: 'ZZZ', icon: 'Z', lifecycleMode: 'task', capabilities: {} },
    ]
    const { merged } = mergeActivityTypes(builtIn, l3)
    expect(merged[0].id).toBe('email')
    expect(merged[1].id).toBe('note')
    expect(merged[2].id).toBe('custom:zzz')
  })
})

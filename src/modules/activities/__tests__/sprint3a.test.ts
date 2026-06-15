import { activityTypes, getActivityTypeById } from '../activity-types'
import { activityCreateSchema } from '../data/validators'
import { deriveSubjectAndNotes, parseParticipants, isInlineType, mergeWithFresh } from '../widgets/injection/timeline/utils'

// ── activityTypes registry — defaultValues ───────────────────────────────────

describe('activityTypes registry', () => {
  it('note has occurredAt=now defaultValue', () => {
    const note = getActivityTypeById('note')
    expect(note?.defaultValues?.occurredAt).toBe('now')
  })

  it('task has dueAt=end_of_day defaultValue', () => {
    const task = getActivityTypeById('task')
    expect(task?.defaultValues?.dueAt).toBe('end_of_day')
  })

  it('meeting has durationMinutes=60 defaultValue', () => {
    const meeting = getActivityTypeById('meeting')
    expect(meeting?.defaultValues?.durationMinutes).toBe(60)
  })

  it('call has durationMinutes=15 defaultValue', () => {
    const call = getActivityTypeById('call')
    expect(call?.defaultValues?.durationMinutes).toBe(15)
  })

  it('all 5 built-in types are present', () => {
    const ids = activityTypes.map((t) => t.id).sort()
    expect(ids).toEqual(['call', 'email', 'meeting', 'note', 'task'])
  })

  it('fact-mode types: note, email', () => {
    const factTypes = activityTypes.filter((t) => t.lifecycleMode === 'fact').map((t) => t.id).sort()
    expect(factTypes).toEqual(['email', 'note'])
  })

  it('task-mode types: call, meeting, task', () => {
    const taskTypes = activityTypes.filter((t) => t.lifecycleMode === 'task').map((t) => t.id).sort()
    expect(taskTypes).toEqual(['call', 'meeting', 'task'])
  })
})

// ── activityCreateSchema — visibility × lifecycleMode cross-rule ─────────────

describe('activityCreateSchema visibility validation', () => {
  const base = {
    activityType: 'note',
    lifecycleMode: 'fact' as const,
    subject: 'Test subject',
    visibility: 'team' as const,
  }

  it('team visibility + fact mode is valid', () => {
    expect(activityCreateSchema.safeParse(base).success).toBe(true)
  })

  it('private visibility + fact mode is rejected', () => {
    const result = activityCreateSchema.safeParse({ ...base, visibility: 'private' })
    expect(result.success).toBe(false)
  })

  it('private visibility + task mode is allowed', () => {
    const result = activityCreateSchema.safeParse({
      ...base,
      activityType: 'task',
      lifecycleMode: 'task' as const,
      visibility: 'private' as const,
    })
    expect(result.success).toBe(true)
  })

  it('linkedEntityType requires linkedEntityId', () => {
    const result = activityCreateSchema.safeParse({
      ...base,
      linkedEntityType: 'customers:person',
    })
    expect(result.success).toBe(false)
  })

  it('linkedEntityType + linkedEntityId pair is valid', () => {
    const result = activityCreateSchema.safeParse({
      ...base,
      linkedEntityType: 'customers:person',
      linkedEntityId: '550e8400-e29b-41d4-a716-446655440001',
    })
    expect(result.success).toBe(true)
  })
})

// ── deriveSubjectAndNotes ────────────────────────────────────────────────────

describe('deriveSubjectAndNotes', () => {
  it('≤100 chars → subject only, notes null', () => {
    const text = 'Short note'
    const result = deriveSubjectAndNotes(text)
    expect(result.subject).toBe('Short note')
    expect(result.notes).toBeNull()
  })

  it('exactly 100 chars → subject only', () => {
    const text = 'a'.repeat(100)
    const result = deriveSubjectAndNotes(text)
    expect(result.subject).toBe(text)
    expect(result.notes).toBeNull()
  })

  it('101 chars → truncated subject + full text as notes', () => {
    const text = 'a'.repeat(101)
    const result = deriveSubjectAndNotes(text)
    expect(result.subject).toBe('a'.repeat(97) + '…')
    expect(result.notes).toBe(text)
  })

  it('long text → subject is 100 chars (97 + ellipsis)', () => {
    const text = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.'
    const result = deriveSubjectAndNotes(text)
    expect(result.subject.length).toBe(98) // 97 chars + '…' (1 char)
    expect(result.subject.endsWith('…')).toBe(true)
    expect(result.notes).toBe(text)
  })

  it('trims whitespace before measuring', () => {
    const text = '  Short  '
    const result = deriveSubjectAndNotes(text)
    expect(result.subject).toBe('Short')
    expect(result.notes).toBeNull()
  })
})

// ── parseParticipants ────────────────────────────────────────────────────────

describe('parseParticipants', () => {
  it('undefined → empty array', () => {
    expect(parseParticipants(undefined)).toEqual([])
  })

  it('empty string → empty array', () => {
    expect(parseParticipants('')).toEqual([])
  })

  it('whitespace-only → empty array', () => {
    expect(parseParticipants('   ')).toEqual([])
  })

  it('single email', () => {
    expect(parseParticipants('a@example.com')).toEqual([{ email: 'a@example.com' }])
  })

  it('comma-separated emails', () => {
    expect(parseParticipants('a@x.com, b@x.com, c@x.com')).toEqual([
      { email: 'a@x.com' },
      { email: 'b@x.com' },
      { email: 'c@x.com' },
    ])
  })

  it('strips whitespace around emails', () => {
    expect(parseParticipants('  a@x.com  ,  b@x.com  ')).toEqual([
      { email: 'a@x.com' },
      { email: 'b@x.com' },
    ])
  })

  it('filters empty entries between commas', () => {
    expect(parseParticipants('a@x.com,,b@x.com')).toEqual([
      { email: 'a@x.com' },
      { email: 'b@x.com' },
    ])
  })
})

// ── isInlineType ─────────────────────────────────────────────────────────────

describe('isInlineType', () => {
  it('undefined typeDef → false', () => {
    expect(isInlineType(undefined)).toBe(false)
  })

  it('note (fact + hasBody) → true', () => {
    expect(isInlineType(getActivityTypeById('note'))).toBe(true)
  })

  it('email (fact + hasBody) → true', () => {
    expect(isInlineType(getActivityTypeById('email'))).toBe(true)
  })

  it('task (task mode) → false', () => {
    expect(isInlineType(getActivityTypeById('task'))).toBe(false)
  })

  it('meeting (task mode) → false', () => {
    expect(isInlineType(getActivityTypeById('meeting'))).toBe(false)
  })

  it('call (task mode, no hasBody) → false', () => {
    expect(isInlineType(getActivityTypeById('call'))).toBe(false)
  })
})

// ── mergeWithFresh ───────────────────────────────────────────────────────────

type CardData = { id: string; subject: string; activityType: string; status: string; dueAt: string | null; occurredAt: string | null; createdAt: string; ownerUserId: string | null }

function card(id: string, extra?: Partial<CardData & { _isOptimistic?: true; _tempId?: string }>): CardData & { _isOptimistic?: true; _tempId?: string } {
  return { id, subject: id, activityType: 'note', status: 'not_started', dueAt: null, occurredAt: null, createdAt: '2026-01-01T00:00:00.000Z', ownerUserId: null, ...extra }
}

describe('mergeWithFresh', () => {
  it('empty current + fresh → fresh only', () => {
    const result = mergeWithFresh([], [card('a'), card('b')])
    expect(result.map((r) => r.id)).toEqual(['a', 'b'])
  })

  it('optimistic placeholder not yet in fresh → kept at front', () => {
    const current = [card('tmp1', { _isOptimistic: true, _tempId: 'tmp1' })]
    const fresh = [card('a'), card('b')]
    const result = mergeWithFresh(current, fresh)
    expect(result.map((r) => r.id)).toEqual(['tmp1', 'a', 'b'])
  })

  it('optimistic placeholder now in fresh (saved) → removed from optimistic', () => {
    // The saved record arrives in fresh with its real ID, not the temp ID
    const current = [card('tmp1', { _isOptimistic: true, _tempId: 'tmp1' }), card('a')]
    // fresh contains 'real-uuid' (the saved one) and 'a'
    const fresh = [card('real-uuid'), card('a')]
    const result = mergeWithFresh(current, fresh)
    // tmp1 optimistic is still kept because fresh doesn't have 'tmp1' id
    expect(result.find((r) => r.id === 'tmp1')).toBeTruthy()
    expect(result.find((r) => r.id === 'real-uuid')).toBeTruthy()
  })

  it('non-optimistic items in current are replaced by fresh', () => {
    const current = [card('a'), card('b')]
    const fresh = [card('a-updated'), card('b')]
    const result = mergeWithFresh(current, fresh)
    // non-optimistic items in current don't survive — fresh wins entirely
    expect(result.find((r) => r.id === 'a')).toBeFalsy()
    expect(result.find((r) => r.id === 'a-updated')).toBeTruthy()
  })

  it('multiple optimistic placeholders — only those absent from fresh survive', () => {
    const current = [
      card('tmp1', { _isOptimistic: true, _tempId: 'tmp1' }),
      card('tmp2', { _isOptimistic: true, _tempId: 'tmp2' }),
    ]
    // fresh doesn't include tmp1 or tmp2 (still pending)
    const fresh = [card('a')]
    const result = mergeWithFresh(current, fresh)
    expect(result.map((r) => r.id)).toEqual(['tmp1', 'tmp2', 'a'])
  })
})

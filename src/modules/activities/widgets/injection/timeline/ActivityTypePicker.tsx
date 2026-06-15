'use client'

import * as React from 'react'
import * as LucideIcons from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import type { ActivityTypeDefinition } from '../../../activity-types'

interface ActivityTypePickerProps {
  types: ActivityTypeDefinition[]
  selected: string | null
  onSelect: (typeId: string) => void
}

function getIcon(iconName: string): LucideIcon {
  const icons = LucideIcons as unknown as Record<string, LucideIcon>
  return (icons[iconName] as LucideIcon | undefined) ?? (icons['Activity'] as LucideIcon)
}

export default function ActivityTypePicker({ types, selected, onSelect }: ActivityTypePickerProps) {
  const t = useT()

  if (types.length === 0) return null

  return (
    <div className="flex flex-wrap gap-2" role="group" aria-label={t('activities.form.type', 'Activity type')}>
      {types.map((type) => {
        const Icon = getIcon(type.icon)
        const isSelected = selected === type.id
        return (
          <button
            key={type.id}
            type="button"
            aria-label={t(type.label, type.id)}
            aria-pressed={isSelected}
            onClick={() => onSelect(type.id)}
            className={[
              'inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              isSelected
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-border bg-muted text-muted-foreground hover:bg-accent hover:text-accent-foreground',
            ].join(' ')}
          >
            <Icon size={14} aria-hidden="true" />
            {t(type.filterLabel ?? type.label, type.id)}
          </button>
        )
      })}
    </div>
  )
}

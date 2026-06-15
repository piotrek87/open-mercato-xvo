'use client'

import * as React from 'react'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import type { ActivityTypeDefinition } from '../../../activity-types'

interface ActivityFilterBarProps {
  availableTypes: ActivityTypeDefinition[]
  activeFilter: string | null
  onChange: (typeId: string | null) => void
}

export default function ActivityFilterBar({
  availableTypes,
  activeFilter,
  onChange,
}: ActivityFilterBarProps) {
  const t = useT()

  React.useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onChange(null)
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [onChange])

  if (availableTypes.length === 0) return null

  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('activities.filter.label', 'Filter by type')}>
      <button
        type="button"
        onClick={() => onChange(null)}
        className={[
          'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors',
          activeFilter === null
            ? 'border-primary bg-primary text-primary-foreground'
            : 'border-border bg-muted text-muted-foreground hover:bg-accent hover:text-accent-foreground',
        ].join(' ')}
      >
        {t('activities.filter.all', 'All')}
      </button>
      {availableTypes.map((type) => (
        <button
          key={type.id}
          type="button"
          onClick={() => onChange(type.id)}
          className={[
            'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors',
            activeFilter === type.id
              ? 'border-primary bg-primary text-primary-foreground'
              : 'border-border bg-muted text-muted-foreground hover:bg-accent hover:text-accent-foreground',
          ].join(' ')}
        >
          {t(type.filterLabel ?? type.label, type.filterLabel ?? type.label)}
        </button>
      ))}
    </div>
  )
}

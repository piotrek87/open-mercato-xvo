'use client'

import * as React from 'react'
import { CalendarDays, AlertCircle, User } from 'lucide-react'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import type { ActivityTypeDefinition } from '../../../activity-types'

export type QuickFilter = 'due_today' | 'overdue' | 'mine' | null

interface ActivityFilterBarProps {
  availableTypes: ActivityTypeDefinition[]
  activeFilter: string | null
  onChange: (typeId: string | null) => void
  /** Quick-filter chip state */
  quickFilter?: QuickFilter
  onQuickFilterChange?: (f: QuickFilter) => void
  /** Date range (ISO date strings YYYY-MM-DD or empty) */
  dateFrom?: string
  dateTo?: string
  onDateRangeChange?: (from: string, to: string) => void
  /** Current logged-in user id — enables "My activities" chip */
  currentUserId?: string | null
}

export default function ActivityFilterBar({
  availableTypes,
  activeFilter,
  onChange,
  quickFilter = null,
  onQuickFilterChange,
  dateFrom = '',
  dateTo = '',
  onDateRangeChange,
  currentUserId,
}: ActivityFilterBarProps) {
  const t = useT()

  React.useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        onChange(null)
        onQuickFilterChange?.(null)
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [onChange, onQuickFilterChange])

  function toggleQuick(f: NonNullable<QuickFilter>) {
    onQuickFilterChange?.(quickFilter === f ? null : f)
  }

  const chipBase = 'inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors'
  const chipInactive = 'border-border bg-muted text-muted-foreground hover:bg-accent hover:text-accent-foreground'
  const chipActive = 'border-primary bg-primary text-primary-foreground'
  const chipError = 'border-status-error-border bg-status-error-bg text-status-error-text'

  return (
    <div className="flex flex-col gap-2">
      {/* Type chips */}
      {availableTypes.length > 0 && (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('activities.filter.label', 'Filter by type')}>
          <button
            type="button"
            onClick={() => onChange(null)}
            className={[chipBase, activeFilter === null ? chipActive : chipInactive].join(' ')}
          >
            {t('activities.filter.all', 'All')}
          </button>
          {availableTypes.map((type) => (
            <button
              key={type.id}
              type="button"
              onClick={() => onChange(type.id)}
              className={[chipBase, activeFilter === type.id ? chipActive : chipInactive].join(' ')}
            >
              {t(type.filterLabel ?? type.label, type.filterLabel ?? type.label)}
            </button>
          ))}
        </div>
      )}

      {/* Quick-filter chips */}
      {onQuickFilterChange && (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('activities.filter.quick.label', 'Quick filters')}>
          <button
            type="button"
            onClick={() => toggleQuick('due_today')}
            className={[chipBase, quickFilter === 'due_today' ? chipActive : chipInactive].join(' ')}
          >
            <CalendarDays className="size-3" aria-hidden="true" />
            {t('activities.filter.dueToday', 'Due today')}
          </button>
          <button
            type="button"
            onClick={() => toggleQuick('overdue')}
            className={[chipBase, quickFilter === 'overdue' ? chipError : chipInactive].join(' ')}
          >
            <AlertCircle className="size-3" aria-hidden="true" />
            {t('activities.filter.overdue', 'Overdue')}
          </button>
          {currentUserId && (
            <button
              type="button"
              onClick={() => toggleQuick('mine')}
              className={[chipBase, quickFilter === 'mine' ? chipActive : chipInactive].join(' ')}
            >
              <User className="size-3" aria-hidden="true" />
              {t('activities.filter.mine', 'My activities')}
            </button>
          )}
        </div>
      )}

      {/* Date range */}
      {onDateRangeChange && (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-muted-foreground whitespace-nowrap">
            {t('activities.filter.dateRange', 'Date range')}
          </span>
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => onDateRangeChange(e.target.value, dateTo)}
            className="text-xs border rounded-md px-2 py-1 bg-background"
            aria-label={t('activities.filter.dateFrom', 'From date')}
          />
          <span className="text-xs text-muted-foreground">–</span>
          <input
            type="date"
            value={dateTo}
            onChange={(e) => onDateRangeChange(dateFrom, e.target.value)}
            className="text-xs border rounded-md px-2 py-1 bg-background"
            aria-label={t('activities.filter.dateTo', 'To date')}
          />
          {(dateFrom || dateTo) && (
            <button
              type="button"
              onClick={() => onDateRangeChange('', '')}
              className="text-xs text-muted-foreground hover:text-foreground"
              aria-label={t('activities.filter.clearDateRange', 'Clear date range')}
            >
              {t('activities.filter.clear', 'Clear')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

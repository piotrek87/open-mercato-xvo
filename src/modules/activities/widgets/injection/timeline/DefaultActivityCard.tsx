'use client'

import * as React from 'react'
import * as Icons from 'lucide-react'
import { EnumBadge, type EnumBadgeMap } from '@open-mercato/ui/backend/ValueIcons'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import type { ActivityTypeDefinition } from '../../../activity-types'

export type ActivityCardData = {
  id: string
  subject: string
  activityType: string
  status: string
  dueAt: string | null
  occurredAt: string | null
  createdAt: string
  ownerUserId: string | null
}

interface DefaultActivityCardProps {
  activity: ActivityCardData
  typeDef?: ActivityTypeDefinition
  compact?: boolean
}

const STATUS_MAP: EnumBadgeMap = {
  not_started: { label: 'Not started', className: 'border-muted text-muted-foreground bg-muted/30' },
  in_progress: { label: 'In progress', className: 'border-blue-200 text-blue-700 bg-blue-50' },
  completed: { label: 'Completed', className: 'border-emerald-200 text-emerald-700 bg-emerald-50' },
  cancelled: { label: 'Cancelled', className: 'border-red-200 text-red-700 bg-red-50' },
}

function ActivityTypeIcon({ iconName, className }: { iconName?: string; className?: string }) {
  const iconKey = (iconName ?? 'Activity') as keyof typeof Icons
  const IconComponent = (Icons[iconKey] as React.ComponentType<{ className?: string; 'aria-hidden'?: string }> | undefined)
    ?? Icons.Activity
  return <IconComponent className={className} aria-hidden="true" />
}

export default function DefaultActivityCard({
  activity,
  typeDef,
  compact = false,
}: DefaultActivityCardProps) {
  const t = useT()

  const dateDisplay = activity.dueAt ?? activity.occurredAt ?? activity.createdAt
  const dateLabel = activity.dueAt
    ? t('activities.card.dueAt', 'Due')
    : activity.occurredAt
      ? t('activities.card.occurredAt', 'On')
      : t('activities.card.createdAt', 'Created')

  if (compact) {
    return (
      <div className="flex items-center gap-2 py-1">
        <ActivityTypeIcon iconName={typeDef?.icon} className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="text-sm text-foreground truncate flex-1">{activity.subject}</span>
        <EnumBadge value={activity.status} map={STATUS_MAP} />
      </div>
    )
  }

  return (
    <div className="rounded-md border border-border bg-card p-3 flex flex-col gap-1.5">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <ActivityTypeIcon iconName={typeDef?.icon} className="size-4 shrink-0 text-muted-foreground" />
          <span className="text-sm font-medium text-foreground truncate">{activity.subject}</span>
        </div>
        <EnumBadge value={activity.status} map={STATUS_MAP} />
      </div>
      <div className="flex items-center gap-4 pl-6">
        <span className="text-xs text-muted-foreground">
          {typeDef ? t(typeDef.label, typeDef.label) : activity.activityType}
        </span>
        {dateDisplay ? (
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <Icons.CalendarIcon className="size-3" aria-hidden="true" />
            {dateLabel}: {new Date(dateDisplay).toLocaleDateString()}
          </span>
        ) : null}
      </div>
    </div>
  )
}

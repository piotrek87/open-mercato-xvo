'use client'
import * as React from 'react'
import { useQuery } from '@tanstack/react-query'
import { Page, PageHeader, PageBody } from '@open-mercato/ui/backend/Page'
import { BarChart } from '@open-mercato/ui/backend/charts'
import { KpiCard } from '@open-mercato/ui/backend/charts'
import { TopNTable } from '@open-mercato/ui/backend/charts'
import { Button } from '@open-mercato/ui/primitives/button'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { Download } from 'lucide-react'

// --- Types ---

type KpiData = { total: number; completed: number; overdue: number }
type VolumeRow = { activityType: string; count: number }
type LeaderRow = { ownerUserId: string | null; count: number }
type ColdDealRow = { linkedEntityId: string; lastActivity: string; daysCold: number }

type StatsData = {
  kpis: KpiData
  volumeByType: VolumeRow[]
  leaderboard: LeaderRow[]
  coldDeals: ColdDealRow[]
  period: { from: string; to: string }
}

type UserRow = { id: string; name?: string | null; email?: string | null }

// --- Date range presets ---

function getLast30DaysRange() {
  const to = new Date()
  const from = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
  return { from: from.toISOString(), to: to.toISOString() }
}

function getLast90DaysRange() {
  const to = new Date()
  const from = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
  return { from: from.toISOString(), to: to.toISOString() }
}

type RangePreset = '30d' | '90d'

function getRange(preset: RangePreset) {
  return preset === '90d' ? getLast90DaysRange() : getLast30DaysRange()
}

// Friendly labels for the built-in activity types shown on the volume chart.
const ACTIVITY_TYPE_LABELS: Record<string, string> = {
  email: 'E-mail',
  meeting: 'Spotkanie',
  call: 'Telefon',
  note: 'Notatka',
  task: 'Zadanie',
}

// --- Page ---

export default function ActivityStatsPage() {
  const t = useT()
  const [preset, setPreset] = React.useState<RangePreset>('30d')
  const range = getRange(preset)

  const { data, isLoading, error } = useQuery({
    queryKey: ['activities-stats', preset],
    queryFn: async () => {
      const params = new URLSearchParams({ from: range.from, to: range.to })
      // apiCall returns { ok, status, result } — the stats payload is in res.result.data.
      const res = await apiCall<{ data?: StatsData; error?: string }>(`/api/activities/stats?${params}`)
      if (!res.ok || !res.result?.data) throw new Error(res.result?.error ?? 'Failed to load stats')
      return res.result.data
    },
  })

  // Resolve leaderboard owner ids → display names (the API returns raw user ids).
  const ownerIds = React.useMemo(
    () => [...new Set((data?.leaderboard ?? []).map((r) => r.ownerUserId).filter((v): v is string => !!v))],
    [data],
  )
  const { data: userMap } = useQuery({
    queryKey: ['activities-stats-users', ownerIds],
    enabled: ownerIds.length > 0,
    queryFn: async () => {
      const res = await apiCall<{ items?: UserRow[] }>(`/api/auth/users?ids=${ownerIds.join(',')}&pageSize=100`)
      const map = new Map<string, string>()
      for (const u of res.result?.items ?? []) {
        map.set(u.id, (u.name?.trim() || u.email?.trim() || u.id))
      }
      return map
    },
  })

  const completionRate =
    data && data.kpis.total > 0
      ? Math.round((data.kpis.completed / data.kpis.total) * 100)
      : null

  // Series label (chart legend / tooltip) — translated so nothing English leaks through.
  const seriesLabel = t('activities.stats.chart.series', 'Liczba')

  const volumeChartData: Array<Record<string, string | number>> = (data?.volumeByType ?? []).map((r) => ({
    name: ACTIVITY_TYPE_LABELS[r.activityType] ?? r.activityType,
    [seriesLabel]: r.count,
  }))

  // Map the owner id to a readable name for display.
  const leaderboardData: Array<Record<string, unknown>> = (data?.leaderboard ?? []).map((r) => ({
    owner: (r.ownerUserId ? userMap?.get(r.ownerUserId) : null) ?? r.ownerUserId ?? '—',
    count: r.count,
  }))

  const leaderboardColumns = [
    { key: 'owner', header: t('activities.stats.column.owner', 'Właściciel') },
    { key: 'count', header: t('activities.stats.column.activities', 'Aktywności'), align: 'right' as const },
  ]

  const coldDealColumns = [
    { key: 'linkedEntityId', header: t('activities.stats.column.dealId', 'Szansa') },
    {
      key: 'daysCold',
      header: t('activities.stats.column.daysCold', 'Dni bez aktywności'),
      align: 'right' as const,
      formatter: (v: unknown) => `${v} dni`,
    },
    {
      key: 'lastActivity',
      header: t('activities.stats.column.lastActivity', 'Ostatnia aktywność'),
      formatter: (v: unknown) =>
        v ? new Date(v as string).toLocaleDateString() : '—',
    },
  ]

  function handleExport() {
    const params = new URLSearchParams({ from: range.from, to: range.to })
    window.location.href = `/api/activities/export?${params}`
  }

  const errMsg = error instanceof Error ? error.message : (error ? String(error) : null)

  return (
    <Page>
      <PageHeader
        title={t('activities.stats.page.title', 'Statystyki aktywności')}
        actions={
          <div className="flex items-center gap-2">
            <div className="flex rounded-md border border-border overflow-hidden text-sm">
              {(['30d', '90d'] as RangePreset[]).map((p) => (
                <button
                  key={p}
                  onClick={() => setPreset(p)}
                  className={[
                    'px-3 py-1.5 font-medium transition-colors',
                    preset === p
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-background text-foreground hover:bg-muted',
                  ].join(' ')}
                >
                  {p === '30d'
                    ? t('activities.stats.range.30d', 'Ostatnie 30 dni')
                    : t('activities.stats.range.90d', 'Ostatnie 90 dni')}
                </button>
              ))}
            </div>
            <Button variant="outline" size="sm" onClick={handleExport} aria-label={t('activities.stats.export.label', 'Eksportuj CSV')}>
              <Download className="mr-2 size-4" />
              {t('activities.stats.export.button', 'Eksportuj CSV')}
            </Button>
          </div>
        }
      />
      <PageBody>
        <div className="space-y-6">
          {/* KPI row */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <KpiCard
              title={t('activities.stats.kpi.total', 'Wszystkie aktywności')}
              value={data?.kpis.total ?? null}
              loading={isLoading}
              error={errMsg}
            />
            <KpiCard
              title={t('activities.stats.kpi.completed', 'Ukończone')}
              value={completionRate}
              suffix="%"
              loading={isLoading}
              error={errMsg}
            />
            <KpiCard
              title={t('activities.stats.kpi.overdue', 'Zaległe zadania')}
              value={data?.kpis.overdue ?? null}
              loading={isLoading}
              error={errMsg}
            />
          </div>

          {/* Volume by type */}
          <BarChart
            title={t('activities.stats.chart.volumeByType', 'Aktywności wg typu')}
            data={volumeChartData}
            index="name"
            categories={[seriesLabel]}
            loading={isLoading}
            error={errMsg}
            layout="vertical"
            emptyMessage={t('activities.stats.chart.empty', 'Brak danych w tym okresie')}
          />

          {/* Leaderboard + Cold deals side by side */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <TopNTable
              title={t('activities.stats.table.leaderboard', 'Ranking zespołu')}
              data={leaderboardData}
              columns={leaderboardColumns}
              loading={isLoading}
              error={errMsg}
              maxRows={10}
              emptyMessage={t('activities.stats.table.empty', 'Brak danych w tym okresie')}
            />
            <TopNTable
              title={t('activities.stats.table.coldDeals', 'Stygnące szanse (14+ dni)')}
              data={(data?.coldDeals ?? []) as Array<Record<string, unknown>>}
              columns={coldDealColumns}
              loading={isLoading}
              error={errMsg}
              maxRows={10}
              emptyMessage={t('activities.stats.table.coldDeals.empty', 'Brak stygnących szans — super!')}
            />
          </div>
        </div>
      </PageBody>
    </Page>
  )
}

'use client'
import * as React from 'react'
import { useQuery } from '@tanstack/react-query'
import { Page, PageHeader, PageBody } from '@open-mercato/ui/backend/Page'
import { BarChart, LineChart, KpiCard, TopNTable } from '@open-mercato/ui/backend/charts'
import { Button } from '@open-mercato/ui/primitives/button'
import { SimpleTooltip } from '@open-mercato/ui/primitives/tooltip'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { Download, Info } from 'lucide-react'

// --- Types ---

type KpiData = {
  total: number
  taskTotal: number
  taskCompleted: number
  taskCompletionRate: number | null
  overdue: number
  coverage: { totalOpen: number; covered: number; rate: number | null }
}
type VolumeRow = { activityType: string; count: number }
type TrendRow = { week: string; count: number }
type LeaderRow = { ownerUserId: string | null; count: number }
type AttentionRow = { dealId: string; title: string | null; lastActivity: string | null; daysCold: number | null }

type StatsData = {
  scope: 'mine' | 'team'
  kpis: KpiData
  volumeByType: VolumeRow[]
  trend: TrendRow[]
  leaderboard: LeaderRow[]
  dealsNeedingAttention: AttentionRow[]
  period: { from: string; to: string }
  coldDays: number
}

type UserRow = { id: string; name?: string | null; email?: string | null }

type RangePreset = '30d' | '90d'
type ScopeMode = 'mine' | 'team'

function getRange(preset: RangePreset) {
  const to = new Date()
  const days = preset === '90d' ? 90 : 30
  const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
  return { from: from.toISOString(), to: to.toISOString() }
}

const ACTIVITY_TYPE_LABELS: Record<string, string> = {
  email: 'E-mail',
  meeting: 'Spotkanie',
  call: 'Telefon',
  note: 'Notatka',
  task: 'Zadanie',
}

// --- Small building blocks ---

/** Info tooltip ("toolbox") explaining what a statistic means + its scope. */
function InfoTip({ text }: { text: string }) {
  return (
    <SimpleTooltip content={text}>
      <span tabIndex={0} role="img" aria-label={text} className="inline-flex cursor-help text-muted-foreground">
        <Info className="size-3.5" />
      </span>
    </SimpleTooltip>
  )
}

/** Card wrapper matching the chart cards, with a title + InfoTip header. */
function Section({ title, tip, children }: { title: string; tip: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="mb-4 flex items-center gap-1.5">
        <h3 className="text-base font-medium text-card-foreground">{title}</h3>
        <InfoTip text={tip} />
      </div>
      {children}
    </div>
  )
}

// --- Page ---

export default function ActivityStatsPage() {
  const t = useT()
  const [preset, setPreset] = React.useState<RangePreset>('30d')
  const [scope, setScope] = React.useState<ScopeMode>('mine')
  const range = getRange(preset)

  const { data, isLoading, error } = useQuery({
    queryKey: ['activities-stats', preset, scope],
    queryFn: async () => {
      const params = new URLSearchParams({ from: range.from, to: range.to, scope })
      const res = await apiCall<{ data?: StatsData; error?: string }>(`/api/activities/stats?${params}`)
      if (!res.ok || !res.result?.data) throw new Error(res.result?.error ?? 'Failed to load stats')
      return res.result.data
    },
  })

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
      for (const u of res.result?.items ?? []) map.set(u.id, (u.name?.trim() || u.email?.trim() || u.id))
      return map
    },
  })

  const isTeam = scope === 'team'
  const coldDays = data?.coldDays ?? 14
  const errMsg = error instanceof Error ? error.message : (error ? String(error) : null)
  const seriesLabel = t('activities.stats.chart.series', 'Liczba')

  const volumeChartData: Array<Record<string, string | number>> = (data?.volumeByType ?? []).map((r) => ({
    name: ACTIVITY_TYPE_LABELS[r.activityType] ?? r.activityType,
    [seriesLabel]: r.count,
  }))

  const trendChartData: Array<Record<string, string | number>> = (data?.trend ?? []).map((r) => ({
    name: new Date(r.week).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }),
    [seriesLabel]: r.count,
  }))

  const leaderboardData: Array<Record<string, unknown>> = (data?.leaderboard ?? []).map((r) => ({
    owner: (r.ownerUserId ? userMap?.get(r.ownerUserId) : null) ?? r.ownerUserId ?? '—',
    count: r.count,
  }))
  const leaderboardColumns = [
    { key: 'owner', header: t('activities.stats.column.owner', 'Właściciel') },
    { key: 'count', header: t('activities.stats.column.activities', 'Aktywności'), align: 'right' as const },
  ]

  const neverLabel = t('activities.stats.column.never', 'Nigdy')
  const daysAgoLabel = t('activities.stats.column.daysAgo', 'dni temu')
  const attentionData: Array<Record<string, unknown>> = (data?.dealsNeedingAttention ?? []).map((r) => ({
    title: r.title || r.dealId,
    daysCold: r.daysCold,
  }))
  // Two columns only (mirrors the leaderboard layout) — TopNTable has no inter-cell padding, so a
  // third right/left-aligned column would visually collide. Framed as "last activity": "Nigdy" =
  // never had any activity (not 0 days), "5 dni temu" = last touched 5 days ago.
  const attentionColumns = [
    { key: 'title', header: t('activities.stats.column.deal', 'Szansa') },
    {
      key: 'daysCold',
      header: t('activities.stats.column.lastActivity', 'Ostatnia aktywność'),
      align: 'right' as const,
      formatter: (v: unknown) => (v === null || v === undefined ? neverLabel : `${v} ${daysAgoLabel}`),
    },
  ]

  function handleExport() {
    const params = new URLSearchParams({ from: range.from, to: range.to })
    window.location.href = `/api/activities/export?${params}`
  }

  const scopeNote = isTeam
    ? t('activities.stats.scope.note.team', 'Dane dla całej organizacji.')
    : t('activities.stats.scope.note.mine', 'Tylko Twoje aktywności i szanse.')
  const periodNote = preset === '90d'
    ? t('activities.stats.range.90d', 'Ostatnie 90 dni')
    : t('activities.stats.range.30d', 'Ostatnie 30 dni')

  function Toggle<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: Array<{ id: T; label: string }> }) {
    return (
      <div className="flex rounded-md border border-border overflow-hidden text-sm">
        {options.map((o) => (
          <button
            key={o.id}
            type="button"
            onClick={() => onChange(o.id)}
            className={[
              'px-3 py-1.5 font-medium transition-colors',
              value === o.id ? 'bg-primary text-primary-foreground' : 'bg-background text-foreground hover:bg-muted',
            ].join(' ')}
          >
            {o.label}
          </button>
        ))}
      </div>
    )
  }

  return (
    <Page>
      <PageHeader
        title={t('activities.stats.page.title', 'Statystyki aktywności')}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Toggle<ScopeMode>
              value={scope}
              onChange={setScope}
              options={[
                { id: 'mine', label: t('activities.stats.scope.mine', 'Moje') },
                { id: 'team', label: t('activities.stats.scope.team', 'Zespół') },
              ]}
            />
            <Toggle<RangePreset>
              value={preset}
              onChange={setPreset}
              options={[
                { id: '30d', label: t('activities.stats.range.30d', 'Ostatnie 30 dni') },
                { id: '90d', label: t('activities.stats.range.90d', 'Ostatnie 90 dni') },
              ]}
            />
            <Button variant="outline" size="sm" onClick={handleExport} aria-label={t('activities.stats.export.label', 'Eksportuj CSV')}>
              <Download className="mr-2 size-4" />
              {t('activities.stats.export.button', 'Eksportuj CSV')}
            </Button>
          </div>
        }
      />
      <PageBody>
        <div className="space-y-6">
          <p className="text-sm text-muted-foreground">{scopeNote} · {periodNote}</p>

          {/* KPI row */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <KpiCard
              title={t('activities.stats.kpi.total', 'Wszystkie aktywności')}
              value={data?.kpis.total ?? null}
              loading={isLoading}
              error={errMsg}
              headerAction={<InfoTip text={t('activities.stats.tip.total', 'Liczba aktywności (e-maile, spotkania, telefony, notatki, zadania) w wybranym okresie i zakresie.')} />}
            />
            <KpiCard
              title={t('activities.stats.kpi.taskCompletion', 'Ukończone zadania')}
              value={data?.kpis.taskCompletionRate ?? null}
              suffix="%"
              loading={isLoading}
              error={errMsg}
              headerAction={<InfoTip text={t('activities.stats.tip.taskCompletion', 'Odsetek ZADAŃ ze statusem „ukończone" spośród wszystkich zadań w okresie. E-maile i spotkania nie są wliczane (nie mają statusu ukończenia).')} />}
            />
            <KpiCard
              title={t('activities.stats.kpi.overdue', 'Zaległe zadania')}
              value={data?.kpis.overdue ?? null}
              loading={isLoading}
              error={errMsg}
              headerAction={<InfoTip text={t('activities.stats.tip.overdue', 'Zadania z terminem, który minął, a które nie są ukończone ani anulowane. Liczone niezależnie od wybranego okresu.')} />}
            />
            <KpiCard
              title={t('activities.stats.kpi.coverage', 'Pokrycie szans')}
              value={data?.kpis.coverage.rate ?? null}
              suffix="%"
              loading={isLoading}
              error={errMsg}
              headerAction={<InfoTip text={t('activities.stats.tip.coverage', 'Odsetek otwartych szans z co najmniej jedną aktywnością w ostatnich {days} dniach. Niskie pokrycie = część szans bez kontaktu.').replace('{days}', String(coldDays))} />}
            />
          </div>

          {/* Trend + volume */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Section
              title={t('activities.stats.chart.trend', 'Aktywności w czasie')}
              tip={t('activities.stats.tip.trend', 'Liczba aktywności w kolejnych tygodniach wybranego okresu — pokazuje tempo pracy.')}
            >
              <LineChart
                data={trendChartData}
                index="name"
                categories={[seriesLabel]}
                loading={isLoading}
                error={errMsg}
                emptyMessage={t('activities.stats.chart.empty', 'Brak danych w tym okresie')}
              />
            </Section>
            <Section
              title={t('activities.stats.chart.volumeByType', 'Aktywności wg typu')}
              tip={t('activities.stats.tip.volume', 'Rozkład aktywności według typu (e-mail, spotkanie, telefon, notatka, zadanie) w wybranym okresie.')}
            >
              <BarChart
                data={volumeChartData}
                index="name"
                categories={[seriesLabel]}
                loading={isLoading}
                error={errMsg}
                layout="vertical"
                emptyMessage={t('activities.stats.chart.empty', 'Brak danych w tym okresie')}
              />
            </Section>
          </div>

          {/* Leaderboard (team only) + deals needing attention */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {isTeam && (
              <Section
                title={t('activities.stats.table.leaderboard', 'Ranking zespołu')}
                tip={t('activities.stats.tip.leaderboard', 'Liczba aktywności na właściciela w okresie. Widok zespołowy — pomaga zarządowi ocenić obciążenie.')}
              >
                <TopNTable
                  data={leaderboardData}
                  columns={leaderboardColumns}
                  loading={isLoading}
                  error={errMsg}
                  maxRows={10}
                  emptyMessage={t('activities.stats.table.empty', 'Brak danych w tym okresie')}
                />
              </Section>
            )}
            <Section
              title={t('activities.stats.table.attention', 'Szanse do uwagi')}
              tip={t('activities.stats.tip.attention', 'Otwarte szanse bez aktywności od {days}+ dni (lub bez żadnej aktywności). Wymagają kontaktu, by nie wystygły.').replace('{days}', String(coldDays))}
            >
              <TopNTable
                data={attentionData}
                columns={attentionColumns}
                loading={isLoading}
                error={errMsg}
                maxRows={10}
                emptyMessage={t('activities.stats.table.attention.empty', 'Brak zaniedbanych szans — super!')}
              />
            </Section>
          </div>
        </div>
      </PageBody>
    </Page>
  )
}

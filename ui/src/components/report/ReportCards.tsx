import { motion } from 'motion/react'
import {
  Activity,
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  Lightbulb,
  ListChecks,
  Route,
  ShieldCheck,
  Target,
} from 'lucide-react'
import { Bar, BarChart, Cell as BarCell, Pie, PieChart, Cell, XAxis, YAxis } from 'recharts'

import { Badge } from '@/components/ui/badge'
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart'
import { severityHex, scoreTone, shortPath, statusTone } from '@/lib/severity'
import { SEVERITIES, type HistoryEntry, type ReportData, type Severity } from '@/lib/types'
import { cn } from '@/lib/utils'

const BRAND = '#10b981'

const chartConfig = Object.fromEntries(
  SEVERITIES.map((severity) => [severity, { label: severity, color: severityHex(severity) }]),
) as ChartConfig

const CARD = 'flex flex-col rounded-xl border border-hairline bg-panel'

export function Card({
  title,
  icon: Icon,
  action,
  children,
  className,
  bodyClassName,
}: {
  title: string
  icon: React.ComponentType<{ className?: string }>
  action?: React.ReactNode
  children: React.ReactNode
  className?: string
  bodyClassName?: string
}) {
  return (
    <section className={cn(CARD, 'p-4', className)}>
      <div className="mb-3 flex shrink-0 items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Icon className="size-3.5 text-muted-foreground" />
          <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{title}</h3>
        </div>
        {action}
      </div>
      <div className={cn('min-h-0 flex-1', bodyClassName)}>{children}</div>
    </section>
  )
}

/* -------------------------------------------------------------- stat cards */

export function StatCards({ data, checksRun }: { data: ReportData; checksRun: number | null }) {
  const tone = scoreTone(data.score.value)
  const chips = SEVERITIES.filter((severity) => data.stats.bySeverity[severity] > 0)

  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <StatCard icon={ShieldCheck} label="Security score" tone={tone.text}>
        <p className={cn('text-3xl font-semibold leading-none tracking-tight', tone.text)}>
          {data.score.value}
          <span className="ml-1 text-sm font-normal text-muted-foreground">/100</span>
        </p>
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-panel-3">
          <motion.div
            className="h-full rounded-full"
            style={{ backgroundColor: tone.solid }}
            initial={{ width: 0 }}
            animate={{ width: `${data.score.value}%` }}
            transition={{ duration: 0.9, ease: [0.16, 1, 0.3, 1] }}
          />
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground">Grade {data.score.grade}</p>
      </StatCard>

      <StatCard icon={Route} label="Endpoints explored">
        <p className="text-3xl font-semibold leading-none tracking-tight">{data.stats.endpointsExplored}</p>
        <p className="mt-3 text-[11px] text-muted-foreground">distinct routes probed</p>
      </StatCard>

      <StatCard icon={ListChecks} label="Checks run">
        <p className="text-3xl font-semibold leading-none tracking-tight">{checksRun ?? '—'}</p>
        <p className="mt-3 text-[11px] text-muted-foreground">deterministic rules executed</p>
      </StatCard>

      <StatCard
        icon={AlertTriangle}
        label="Vulnerabilities"
        tone={data.stats.vulnerabilitiesFound > 0 ? 'text-red-600 dark:text-red-300' : undefined}
      >
        <p
          className={cn(
            'text-3xl font-semibold leading-none tracking-tight',
            data.stats.vulnerabilitiesFound > 0 && 'text-red-600 dark:text-red-300',
          )}
        >
          {data.stats.vulnerabilitiesFound}
        </p>
        <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1">
          {chips.length === 0 ? (
            <span className="text-[11px] text-muted-foreground">none found</span>
          ) : (
            chips.map((severity) => (
              <span key={severity} className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <span className="size-2 rounded-full" style={{ backgroundColor: severityHex(severity) }} />
                <span className="font-mono">{data.stats.bySeverity[severity]}</span>
                {severity}
              </span>
            ))
          )}
        </div>
      </StatCard>
    </div>
  )
}

function StatCard({
  icon: Icon,
  label,
  children,
  tone,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  children: React.ReactNode
  tone?: string
}) {
  return (
    <motion.section
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
      className={cn(CARD, 'p-4')}
    >
      <div className="mb-3 flex items-center gap-2">
        <Icon className={cn('size-3.5', tone ?? 'text-muted-foreground')} />
        <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</h3>
      </div>
      {children}
    </motion.section>
  )
}

/* ------------------------------------------------------------- distribution */

export function DistributionCard({
  data,
  filter,
  onFilter,
}: {
  data: ReportData
  filter: string | null
  onFilter: (severity: Severity) => void
}) {
  const distribution = data.distribution.filter((entry) => entry.count > 0)
  const findings = data.findings.length
  const pieData = distribution.length > 0 ? distribution : [{ severity: 'Info' as Severity, count: 1 }]

  return (
    <Card
      title="Vulnerability distribution"
      icon={Target}
      action={
        distribution.length > 0 ? (
          <span className="text-[10px] text-muted-foreground">click to filter</span>
        ) : undefined
      }
    >
      <div className="flex h-full flex-col items-center justify-center gap-5 lg:flex-row lg:gap-3">
        <div className="relative shrink-0">
          <ChartContainer config={chartConfig} className="aspect-square h-[168px]">
            <PieChart>
              <ChartTooltip cursor={false} content={<ChartTooltipContent hideLabel nameKey="severity" />} />
              <Pie
                data={pieData}
                dataKey="count"
                nameKey="severity"
                innerRadius={54}
                outerRadius={80}
                paddingAngle={distribution.length > 1 ? 3 : 0}
                strokeWidth={0}
                onClick={(sector: unknown) => {
                  const item = sector as { payload?: { severity?: Severity }; severity?: Severity }
                  const severity = item?.payload?.severity ?? item?.severity
                  if (severity) onFilter(severity)
                }}
                className="cursor-pointer"
              >
                {pieData.map((entry) => (
                  <Cell
                    key={entry.severity}
                    fill={severityHex(entry.severity)}
                    opacity={filter && filter !== entry.severity ? 0.28 : 1}
                  />
                ))}
              </Pie>
            </PieChart>
          </ChartContainer>
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
            <span className="text-xl font-semibold leading-none">{findings}</span>
            <span className="mt-1 text-[10px] text-muted-foreground">total</span>
          </div>
        </div>

        <ul className="w-full min-w-0 space-y-1">
          {SEVERITIES.filter((severity) => distribution.some((entry) => entry.severity === severity)).map((severity) => {
            const count = distribution.find((entry) => entry.severity === severity)?.count ?? 0
            const share = findings > 0 ? Math.round((count / findings) * 100) : 0
            return (
              <li key={severity}>
                <button
                  type="button"
                  onClick={() => onFilter(severity)}
                  className={cn(
                    'w-full rounded-md px-2 py-1 text-left transition-colors hover:bg-panel-2',
                    filter === severity && 'bg-panel-3',
                  )}
                >
                  <div className="flex items-center gap-2">
                    <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: severityHex(severity) }} />
                    <span className="flex-1 text-[11px]">{severity}</span>
                    <span className="font-mono text-[11px]">{count}</span>
                    <span className="w-7 text-right font-mono text-[10px] text-muted-foreground">{share}%</span>
                  </div>
                </button>
              </li>
            )
          })}
          {distribution.length === 0 && <li className="px-2 text-[11px] text-muted-foreground">No findings.</li>}
        </ul>
      </div>
    </Card>
  )
}

/* --------------------------------------------------------------- top types */

export function TopTypesCard({
  data,
  filter,
  onFilter,
}: {
  data: ReportData
  filter: string | null
  onFilter: (type: string) => void
}) {
  const rows = data.topTypes.map((type) => ({
    ...type,
    short: type.type.length > 24 ? `${type.type.slice(0, 23)}…` : type.type,
  }))
  const height = Math.max(150, rows.length * 34 + 16)

  return (
    <Card
      title="Top vulnerability types"
      icon={BarChart3}
      action={rows.length > 0 ? <span className="text-[10px] text-muted-foreground">click to filter</span> : undefined}
    >
      {rows.length === 0 ? (
        <p className="py-8 text-center text-[11px] text-muted-foreground">No recurring classes identified.</p>
      ) : (
        <ChartContainer config={chartConfig} style={{ height }} className="w-full text-muted-foreground">
          <BarChart layout="vertical" data={rows} margin={{ left: 0, right: 24, top: 0, bottom: 0 }}>
            <XAxis type="number" hide allowDecimals={false} />
            <YAxis
              type="category"
              dataKey="short"
              width={150}
              axisLine={false}
              tickLine={false}
              tick={{ fontSize: 10.5, fill: 'currentColor' }}
            />
            <ChartTooltip
              cursor={{ fill: 'color-mix(in oklab, currentColor 6%, transparent)' }}
              content={
                <ChartTooltipContent
                  hideLabel
                  formatter={(value, _name, item) => {
                    const payload = (item?.payload ?? {}) as { type?: string; description?: string }
                    return (
                      <div className="max-w-[240px] space-y-1">
                        <p className="text-xs font-medium">
                          {payload.type ?? 'Type'} — {String(value)}
                        </p>
                        {payload.description && (
                          <p className="text-[11px] leading-relaxed text-muted-foreground">{payload.description}</p>
                        )}
                      </div>
                    )
                  }}
                />
              }
            />
            <Bar
              dataKey="count"
              radius={[0, 4, 4, 0]}
              barSize={14}
              onClick={(entry: unknown) => {
                const item = entry as { payload?: { type?: string }; type?: string }
                const type = item?.payload?.type ?? item?.type
                if (type) onFilter(type)
              }}
              className="cursor-pointer"
            >
              {rows.map((row) => (
                <BarCell key={row.type} fill={BRAND} fillOpacity={filter && filter !== row.type ? 0.3 : 0.85} />
              ))}
            </Bar>
          </BarChart>
        </ChartContainer>
      )}
    </Card>
  )
}

/* ---------------------------------------------------------------- activity */

export function ActivityCard({ entries }: { entries: HistoryEntry[] }) {
  const recent = entries.slice(0, 6)

  return (
    <Card
      title="Recent activity"
      icon={Activity}
      action={<span className="text-[10px] text-muted-foreground">{entries.length} total</span>}
    >
      {recent.length === 0 ? (
        <p className="py-8 text-center text-[11px] text-muted-foreground">
          Nothing yet — probes and model calls land here.
        </p>
      ) : (
        <ul className="space-y-1">
          {recent.map((entry) => (
            <li key={entry.id} className="flex items-center gap-2 rounded-md px-1 py-1">
              {entry.kind === 'llm' ? (
                <span className="shrink-0 rounded-full bg-fuchsia-500/12 px-1.5 py-0.5 font-mono text-[9px] text-fuchsia-300 ring-1 ring-fuchsia-500/20">
                  LLM
                </span>
              ) : (
                <span
                  className={cn(
                    'shrink-0 rounded-full px-1.5 py-0.5 font-mono text-[9px] ring-1',
                    statusTone(entry.response?.status ?? 0),
                  )}
                >
                  {entry.response?.status ?? 'ERR'}
                </span>
              )}
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
                {entry.kind === 'llm' ? entry.request.model : shortPath(entry.request.url)}
              </span>
              <span className="shrink-0 font-mono text-[9px] text-muted-foreground/60">
                {new Date(entry.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

/* --------------------------------------------------------- recommendations */

export function RecommendationsCard({ data }: { data: ReportData }) {
  return (
    <Card title="Recommendations" icon={Lightbulb}>
      {data.recommendations.length === 0 ? (
        <p className="py-6 text-center text-[11px] text-muted-foreground">Nothing to action.</p>
      ) : (
        <ol className="space-y-2.5">
          {data.recommendations.map((item, index) => (
            <li key={`${item.priority}-${index}`} className="flex gap-2.5">
              <Badge
                variant="outline"
                className={cn(
                  'mt-0.5 h-5 shrink-0 border-0 px-2 text-[10px] ring-1',
                  /immediate|now|critical/i.test(item.priority)
                    ? 'bg-red-500/10 text-red-300 ring-red-500/25'
                    : /short|soon/i.test(item.priority)
                      ? 'bg-amber-500/10 text-amber-300 ring-amber-500/25'
                      : 'bg-panel-2 text-muted-foreground ring-hairline',
                )}
              >
                {item.priority}
              </Badge>
              <span className="text-[11.5px] leading-relaxed text-muted-foreground">{item.action}</span>
            </li>
          ))}
        </ol>
      )}
    </Card>
  )
}

/* ---------------------------------------------------------------- coverage */

export function CoverageCard({ data }: { data: ReportData }) {
  const columns = [
    { title: 'Covered', icon: CheckCircle2, items: data.coverage.tested, tone: 'text-brand' },
    { title: 'Not covered', icon: AlertTriangle, items: data.coverage.notCovered, tone: 'text-amber-300' },
  ]

  return (
    <Card title="Coverage" icon={CheckCircle2}>
      <div className="grid gap-4 sm:grid-cols-2">
        {columns.map((column) => (
          <div key={column.title}>
            <div className="mb-1.5 flex items-center gap-1.5">
              <column.icon className={cn('size-3', column.tone)} />
              <span className="text-[11px] font-medium">{column.title}</span>
              <span className="font-mono text-[10px] text-muted-foreground">{column.items.length}</span>
            </div>
            {column.items.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">—</p>
            ) : (
              <ul className="space-y-1">
                {column.items.map((item, index) => (
                  <li key={index} className="text-[11px] leading-relaxed text-muted-foreground">
                    {item}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
    </Card>
  )
}

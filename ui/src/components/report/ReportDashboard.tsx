import { AnimatePresence, motion } from 'motion/react'
import {
  ChevronRight,
  ExternalLink,
  FileWarning,
  History,
  LayoutDashboard,
  ListChecks,
  Loader2,
  RefreshCw,
  ShieldAlert,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { HistoryPanel } from '@/components/dashboard/HistoryPanel'
import { AssistantCard } from '@/components/report/AssistantCard'
import { ActivityCard, CoverageCard, DistributionCard, RecommendationsCard, StatCards, TopTypesCard } from '@/components/report/ReportCards'
import { ReportDetail } from '@/components/report/ReportDetail'
import { ReportFindings } from '@/components/report/ReportFindings'
import { Button } from '@/components/ui/button'
import type { useAgent } from '@/hooks/useAgent'
import type { useHistory } from '@/hooks/useHistory'
import type { useScan } from '@/hooks/useScan'
import { fetchReport, streamSse } from '@/lib/api'
import type { ReportData, ReportFilter, ReportFinding } from '@/lib/types'
import { cn } from '@/lib/utils'

const REPORT_CACHE_TIMEOUT_MS = 15_000
const REPORT_GENERATION_TIMEOUT_MS = 180_000

type ReportTab = 'overview' | 'findings' | 'history'

type GenerateEvent =
  | { type: 'status'; text: string }
  | { type: 'done'; data: ReportData }
  | { type: 'error'; message: string }

interface ReportDashboardProps {
  target: string
  scan: ReturnType<typeof useScan>
  history: ReturnType<typeof useHistory>
  agent: ReturnType<typeof useAgent>
  onReady?: () => void
}

export function ReportDashboard(props: ReportDashboardProps) {
  return <ReportDashboardContent key={props.target} {...props} />
}

function ReportDashboardContent({ target, scan, history, agent, onReady }: ReportDashboardProps) {
  const [data, setData] = useState<ReportData | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<ReportTab>('overview')
  const [selected, setSelected] = useState<ReportFinding | null>(null)
  const [filter, setFilter] = useState<ReportFilter | null>(null)

  const activeRequest = useRef<AbortController | null>(null)

  const loadReport = useCallback(async (reuseCache: boolean) => {
    activeRequest.current?.abort()
    const controller = new AbortController()
    activeRequest.current = controller
    const isCurrent = () => activeRequest.current === controller && !controller.signal.aborted
    let terminal = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const startDeadline = (milliseconds: number, message: string) => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        if (!isCurrent() || terminal) return
        setError(message)
        setStatus(null)
        controller.abort()
      }, milliseconds)
    }
    const clearDeadline = () => clearTimeout(timer)
    controller.signal.addEventListener('abort', clearDeadline, { once: true })
    setError(null)
    setStatus(reuseCache ? 'Loading saved report…' : 'Generating report…')

    try {
      if (reuseCache) {
        startDeadline(REPORT_CACHE_TIMEOUT_MS, 'Loading the saved report timed out. Please try again.')
        const existing = await fetchReport(controller.signal)
        if (!isCurrent()) return
        if (existing && existing.meta.target === target) {
          setData(existing)
          onReady?.()
          return
        }
      }

      setStatus('Generating report…')
      startDeadline(REPORT_GENERATION_TIMEOUT_MS, 'Report generation timed out. Please try again.')
      await streamSse<GenerateEvent>('/api/report', { target }, (event) => {
        if (!isCurrent() || terminal) return
        if (event.type === 'status') setStatus(event.text)
        else if (event.type === 'done' || event.type === 'error') {
          terminal = true
          clearDeadline()
          setStatus(null)
          if (event.type === 'done') {
            setData(event.data)
            onReady?.()
          } else {
            setError(event.message)
          }
          controller.abort()
        }
      }, controller.signal)
      if (isCurrent() && !terminal) {
        throw new Error('Report generation ended before a report was received. Please try again.')
      }
    } catch (caught) {
      if (isCurrent()) setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      clearDeadline()
      controller.signal.removeEventListener('abort', clearDeadline)
      if (activeRequest.current === controller) {
        activeRequest.current = null
        setStatus(null)
      }
    }
  }, [target, onReady])

  const generate = () => loadReport(false)
  const scanFresh = scan.scannedTarget === target && scan.summary !== null

  useEffect(() => {
    let cancelled = false
    if (scanFresh) {
      queueMicrotask(() => {
        if (!cancelled) void loadReport(true)
      })
    }
    return () => {
      cancelled = true
      const controller = activeRequest.current
      activeRequest.current = null
      controller?.abort()
    }
  }, [scanFresh, loadReport])

  const selectFinding = (finding: ReportFinding) => {
    setSelected((current) => (current?.id === finding.id ? null : finding))
  }

  const applyFilter = (next: ReportFilter | null) => {
    setFilter(next)
    if (next) setSelected(null)
  }

  if (!scanFresh) {
    return <NeedsScan target={target} onRun={() => void scan.run(target)} running={scan.running} />
  }

  if (!data) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <GeneratingHeader status={status} />
        <GeneratingPanel status={status} error={error} onRetry={() => void generate()} />
      </div>
    )
  }

  const checksRun = scan.summary?.total ?? null

  return (
    <div className="flex min-h-0 flex-1">
      <Nav tab={tab} onTab={setTab} findings={data.findings.length} activity={history.entries.length} />

      <div className="flex min-h-0 flex-1 flex-col">
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-hairline px-5 py-3.5">
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold tracking-tight">{data.meta.title}</h1>
            <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">{data.meta.verdict}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <span className="hidden font-mono text-[10px] text-muted-foreground lg:block">{data.meta.model}</span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void generate()}
              disabled={Boolean(status)}
              className="h-8 gap-1.5"
            >
              {status ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
              Regenerate
            </Button>
          </div>
        </header>

        {error && <p role="alert" className="shrink-0 px-5 py-3 text-xs text-red-300">{error}</p>}

        {status && (
          <div className="h-0.5 shrink-0 overflow-hidden bg-panel-3">
            <motion.div
              className="h-full w-1/3 rounded-full bg-brand/70"
              animate={{ x: ['-100%', '300%'] }}
              transition={{ duration: 1.4, repeat: Infinity, ease: 'easeInOut' }}
            />
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto">
          {tab === 'overview' && (
            <div className="space-y-4 p-5">
              <StatCards data={data} checksRun={checksRun} />

              <div className="grid gap-4 xl:grid-cols-3">
                <DistributionCard
                  data={data}
                  filter={filter?.kind === 'severity' ? filter.value : null}
                  onFilter={(severity) =>
                    applyFilter(
                      filter?.kind === 'severity' && filter.value === severity
                        ? null
                        : { kind: 'severity', value: severity },
                    )
                  }
                />
                <TopTypesCard
                  data={data}
                  filter={filter?.kind === 'category' ? filter.value : null}
                  onFilter={(type) =>
                    applyFilter(
                      filter?.kind === 'category' && filter.value === type ? null : { kind: 'category', value: type },
                    )
                  }
                />
                <ActivityCard entries={history.entries} />
              </div>

              {/* The ROW must be definite, not just the container. A grid's implicit row is
                  auto-sized, so `h-full` on the children resolves against content height —
                  the row grows with the chat and the card stops scrolling. `xl:h-[460px]`
                  alone only pins the box, not the track. */}
              <div className="grid gap-4 xl:h-[460px] xl:grid-rows-[460px] xl:grid-cols-[minmax(0,1fr)_360px]">
                <div className="flex h-[420px] min-h-0 flex-col overflow-hidden rounded-xl border border-hairline bg-panel xl:h-full">
                  <ReportFindings
                    findings={data.findings}
                    selectedId={selected?.id ?? null}
                    onSelect={selectFinding}
                    filter={filter}
                    onClearFilter={() => setFilter(null)}
                    compact
                    onViewAll={() => setTab('findings')}
                  />
                </div>

                <div className="h-[420px] min-h-0 xl:h-full">
                  <AnimatePresence mode="wait" initial={false}>
                    {selected ? (
                      <motion.div
                        key="detail"
                        initial={{ opacity: 0, x: 8 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0, x: -8 }}
                        transition={{ duration: 0.18 }}
                        className="h-full overflow-hidden rounded-xl border border-hairline bg-panel"
                      >
                        <ReportDetail data={data} finding={selected} onClose={() => setSelected(null)} />
                      </motion.div>
                    ) : (
                      <motion.div
                        key="assistant"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.18 }}
                        className="h-full"
                      >
                        <AssistantCard
                          messages={agent.messages}
                          running={agent.running}
                          error={agent.error}
                          onAsk={(prompt) => void agent.send(target, prompt, agent.sessionId)}
                        />
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              </div>

              <div className="grid gap-4 lg:grid-cols-2">
                <RecommendationsCard data={data} />
                <CoverageCard data={data} />
              </div>
            </div>
          )}

          {tab === 'findings' && (
            <div className="flex h-full flex-col">
              <ReportFindings
                findings={data.findings}
                selectedId={selected?.id ?? null}
                onSelect={selectFinding}
                filter={filter}
                onClearFilter={() => setFilter(null)}
              />
              {selected && (
                <div className="h-[45%] shrink-0 border-t border-hairline">
                  <ReportDetail data={data} finding={selected} onClose={() => setSelected(null)} />
                </div>
              )}
            </div>
          )}

          {tab === 'history' && (
            <div className="h-full">
              <HistoryPanel
                entries={history.entries}
                selected={history.selectedEntry}
                onSelect={history.setSelected}
                onCleared={() => void history.refresh()}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/* --------------------------------------------------------------------- nav */

function Nav({
  tab,
  onTab,
  findings,
  activity,
}: {
  tab: ReportTab
  onTab: (tab: ReportTab) => void
  findings: number
  activity: number
}) {
  const items: Array<{ key: ReportTab; label: string; icon: typeof LayoutDashboard; badge?: number }> = [
    { key: 'overview', label: 'Overview', icon: LayoutDashboard },
    { key: 'findings', label: 'Vulnerabilities', icon: ShieldAlert, badge: findings },
    { key: 'history', label: 'History', icon: History, badge: activity },
  ]

  return (
    <nav className="flex w-[196px] shrink-0 flex-col border-r border-hairline bg-inset px-2.5 py-3">
      <div className="mb-4 flex items-center gap-2 px-2">
        <div className="flex size-6 items-center justify-center rounded-md bg-brand/15 ring-1 ring-brand/25">
          <ListChecks className="size-3.5 text-brand" />
        </div>
        <span className="text-xs font-medium">Report</span>
      </div>

      <ul className="space-y-0.5">
        {items.map((item) => {
          const active = tab === item.key
          return (
            <li key={item.key}>
              <button
                type="button"
                onClick={() => onTab(item.key)}
                className={cn(
                  'group relative flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-xs transition-colors',
                  active ? 'bg-panel-3 text-foreground' : 'text-muted-foreground hover:bg-panel-2 hover:text-foreground',
                )}
              >
                {active && (
                  <motion.span
                    layoutId="report-nav-active"
                    className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-brand"
                    transition={{ type: 'spring', stiffness: 500, damping: 34 }}
                  />
                )}
                <item.icon className={cn('size-3.5 shrink-0', active && 'text-brand')} />
                <span className="flex-1">{item.label}</span>
                {item.badge !== undefined && item.badge > 0 && (
                  <span className="font-mono text-[10px] text-muted-foreground">{item.badge}</span>
                )}
                <ChevronRight
                  className={cn(
                    'size-3 shrink-0 transition-transform',
                    active ? 'text-muted-foreground' : 'text-transparent group-hover:text-muted-foreground/50',
                  )}
                />
              </button>
            </li>
          )
        })}
      </ul>

      <a
        href="/report.html"
        target="_blank"
        rel="noreferrer"
        className="mt-auto flex items-center gap-2 rounded-lg px-2.5 py-2 text-[11px] text-muted-foreground transition-colors hover:bg-panel-2 hover:text-foreground"
      >
        <ExternalLink className="size-3.5" />
        Open report.html
      </a>
    </nav>
  )
}

/* ------------------------------------------------------------- gate states */

function NeedsScan({ target, onRun, running }: { target: string; onRun: () => void; running: boolean }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6">
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
        className="w-full max-w-md rounded-2xl border border-hairline bg-panel p-7 text-center"
      >
        <div className="mx-auto flex size-11 items-center justify-center rounded-xl border border-brand/25 bg-brand/10">
          <ListChecks className="size-5 text-brand" />
        </div>

        <h2 className="mt-4 text-sm font-medium">Run the checks first</h2>
        <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
          The report is built from a scan of{' '}
          <span className="font-mono text-[11px] text-foreground/80">{target}</span>. Run the automated checks and it
          generates straight after — no findings are shown until there is something real behind them.
        </p>

        <Button onClick={onRun} disabled={running} className="mt-5 gap-2">
          {running ? <Loader2 className="size-4 animate-spin" /> : <ListChecks className="size-4" />}
          {running ? 'Scanning…' : 'Run checks'}
        </Button>

        <p className="mt-4 text-[11px] leading-relaxed text-muted-foreground/70">
          Running the agent as well produces a richer report — findings.md is the evidence it quotes.
        </p>
      </motion.div>
    </div>
  )
}

function GeneratingHeader({ status }: { status: string | null }) {
  return (
    <div className="flex shrink-0 items-center gap-3 border-b border-hairline px-5 py-3.5">
      <div className="h-4 w-52 animate-pulse rounded bg-panel-2" />
      <div className="ml-auto h-8 w-28 animate-pulse rounded-lg bg-panel-2" />
      {status && <span className="hidden text-[11px] text-muted-foreground lg:block">{status}</span>}
    </div>
  )
}

function GeneratingPanel({
  status,
  error,
  onRetry,
}: {
  status: string | null
  error: string | null
  onRetry: () => void
}) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6">
      <div className="w-full max-w-md text-center">
        {error ? (
          <>
            <FileWarning className="mx-auto size-6 text-red-400" />
            <h2 className="mt-3 text-sm font-medium">The report could not be generated</h2>
            <p className="mt-1.5 text-xs text-red-300">{error}</p>
            <Button variant="outline" size="sm" className="mt-4 gap-1.5" onClick={onRetry}>
              <RefreshCw className="size-3.5" />
              Try again
            </Button>
            <a
              href="/final-report.html"
              target="_blank"
              rel="noreferrer"
              className="mt-3 block text-[11px] text-muted-foreground transition-colors hover:text-foreground"
            >
              Or open the static report
            </a>
          </>
        ) : (
          <>
            <motion.div
              animate={{ scale: [1, 1.08, 1], opacity: [0.7, 1, 0.7] }}
              transition={{ duration: 1.6, repeat: Infinity, ease: 'easeInOut' }}
              className="mx-auto flex size-11 items-center justify-center rounded-xl border border-brand/25 bg-brand/10"
            >
              <Loader2 className="size-5 animate-spin text-brand" />
            </motion.div>
            <h2 className="mt-4 text-sm font-medium">Generating report</h2>
            <p className="mt-1.5 text-xs text-muted-foreground">{status ?? 'Starting…'}</p>
            <div className="mx-auto mt-5 h-1 w-56 overflow-hidden rounded-full bg-panel-3">
              <motion.div
                className="h-full w-1/3 rounded-full bg-brand/70"
                animate={{ x: ['-100%', '300%'] }}
                transition={{ duration: 1.4, repeat: Infinity, ease: 'easeInOut' }}
              />
            </div>
          </>
        )}
      </div>
    </div>
  )
}

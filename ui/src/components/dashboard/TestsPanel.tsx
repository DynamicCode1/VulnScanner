import { AnimatePresence, motion } from 'motion/react'
import { AlertTriangle, Check, ChevronRight, CircleDashed, Loader2, MinusCircle } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { CodeBlock } from '@/components/shared/CodeBlock'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Progress } from '@/components/ui/progress'
import { severityTone, statusTone } from '@/lib/severity'
import type { CheckState } from '@/lib/types'
import { cn } from '@/lib/utils'

interface TestsPanelProps {
  checks: CheckState[]
  running: boolean
  summary: { total: number; vulnerable: number; clean: number; errored: number; durationMs: number } | null
  error: string | null
}

export function TestsPanel({ checks, running, summary, error }: TestsPanelProps) {
  const [selected, setSelected] = useState<CheckState | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const done = checks.filter((entry) => entry.status === 'done').length
  const total = checks.length
  const percent = total === 0 ? 0 : Math.round((done / total) * 100)
  const activeIndex = checks.findIndex((entry) => entry.status === 'running')

  // Follow the sweep. `nearest` keeps movement small, and the smooth scroll lags the
  // reveal slightly — that lag is what reads as a scan rather than a jump cut.
  useEffect(() => {
    if (!running || activeIndex < 0) return
    const row = listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)
    row?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [activeIndex, running])

  return (
    <section className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-hairline px-3 py-2">
        <div className="flex items-center gap-2">
          <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Automated checks</h2>
          {total > 0 && (
            <span className="font-mono text-[11px] text-muted-foreground">
              {done}/{total}
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5">
          {running && total > 0 && (
            <span className="flex items-center gap-1.5 text-[11px] text-brand">
              <Loader2 className="size-3 animate-spin" />
              scanning
            </span>
          )}

          {summary && !running && (
            <>
              <SummaryChip tone="bad" value={summary.vulnerable} label="hit" />
              <SummaryChip tone="good" value={summary.clean} label="clear" />
              {summary.errored > 0 && <SummaryChip tone="warn" value={summary.errored} label="error" />}
              <span className="ml-1 font-mono text-[11px] text-muted-foreground">{summary.durationMs}ms</span>
            </>
          )}
        </div>
      </div>

      {(running || percent > 0) && (
        <Progress value={percent} className="h-0.5 shrink-0 rounded-none bg-panel-3" />
      )}

      {error && (
        <div className="mx-3 mt-3 flex items-start gap-2 rounded-lg border border-red-500/25 bg-red-500/[0.07] p-2.5 text-xs text-red-300">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto">
        {checks.length === 0 ? (
          <EmptyTests running={running} />
        ) : (
          <ul className="p-1.5">
            <AnimatePresence initial={false}>
              {checks.map((entry) => (
                <CheckRow key={entry.meta.index} entry={entry} onOpen={() => setSelected(entry)} />
              ))}
            </AnimatePresence>
          </ul>
        )}
      </div>

      <CheckDetail entry={selected} onClose={() => setSelected(null)} />
    </section>
  )
}

function SummaryChip({ tone, value, label }: { tone: 'bad' | 'good' | 'warn'; value: number; label: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1',
        tone === 'bad' && 'bg-red-500/15 text-red-300 ring-red-500/25',
        tone === 'good' && 'bg-brand/15 text-brand ring-brand/25',
        tone === 'warn' && 'bg-amber-500/15 text-amber-300 ring-amber-500/25',
      )}
    >
      <span className="font-mono">{value}</span>
      {label}
    </span>
  )
}

function EmptyTests({ running }: { running: boolean }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      <CircleDashed className={cn('size-5 text-muted-foreground/60', running && 'animate-spin')} />
      <p className="text-xs text-muted-foreground">
        {running ? 'Starting the rule engine…' : 'Press Run to execute the rule set against the target.'}
      </p>
    </div>
  )
}

function CheckRow({ entry, onOpen }: { entry: CheckState; onOpen: () => void }) {
  const { meta, status, outcome } = entry
  const hit = outcome?.vulnerable === true
  const failed = Boolean(outcome?.error)

  return (
    // No layout animation here: all rows mount at once and only their status changes,
    // so measuring 134 of them on every reveal tick would cost more than it shows.
    <li data-index={meta.index}>
      <button
        type="button"
        onClick={onOpen}
        disabled={status !== 'done'}
        className={cn(
          'group flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors',
          status === 'done' ? 'hover:bg-panel-2' : 'cursor-default',
        )}
      >
        <StatusIcon status={status} hit={hit} failed={failed} />

        <span
          className={cn(
            'min-w-0 flex-1 truncate text-xs',
            status === 'queued' && 'text-muted-foreground/60',
            status === 'running' && 'text-foreground/90',
          )}
        >
          {meta.title}
        </span>

        {status === 'running' && <span className="shrink-0 font-mono text-[11px] text-muted-foreground">running</span>}

        {status === 'done' && (
          <motion.span
            initial={{ scale: 0.85, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ type: 'spring', stiffness: 500, damping: 28 }}
            className="shrink-0"
          >
            {failed ? (
              <Badge variant="outline" className="h-5 border-hairline px-1.5 text-[11px] text-muted-foreground">
                error
              </Badge>
            ) : hit ? (
              <Badge
                variant="outline"
                className={cn('h-5 border-0 px-1.5 text-[11px] ring-1', severityTone(meta.severity))}
              >
                {meta.severity.toFixed(0)} · hit
              </Badge>
            ) : (
              <Badge
                variant="outline"
                className="h-5 border-0 bg-panel px-1.5 text-[11px] text-muted-foreground ring-1 ring-hairline"
              >
                clear
              </Badge>
            )}
          </motion.span>
        )}

        {status === 'done' && (
          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/40 transition-transform group-hover:translate-x-0.5" />
        )}
      </button>
    </li>
  )
}

function StatusIcon({ status, hit, failed }: { status: CheckState['status']; hit: boolean; failed: boolean }) {
  if (status === 'running') return <Loader2 className="size-3.5 shrink-0 animate-spin text-brand" />
  if (status === 'queued') return <CircleDashed className="size-3.5 shrink-0 text-muted-foreground/40" />
  if (failed) return <MinusCircle className="size-3.5 shrink-0 text-muted-foreground" />
  if (hit) return <AlertTriangle className="size-3.5 shrink-0 text-red-400" />
  return <Check className="size-3.5 shrink-0 text-ok/70" />
}

function CheckDetail({ entry, onClose }: { entry: CheckState | null; onClose: () => void }) {
  const outcome = entry?.outcome

  const requestText = useMemo(() => {
    if (!outcome) return ''
    const headers = Object.entries(outcome.request.headers)
      .map(([name, value]) => `${name}: ${value}`)
      .join('\n')
    return [`${outcome.request.method} ${outcome.request.url}`, headers, outcome.request.body ?? '']
      .filter(Boolean)
      .join('\n')
  }, [outcome])

  return (
    <Dialog open={Boolean(entry)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        {entry && outcome && (
          <>
            <DialogHeader>
              <div className="mb-1 flex items-center gap-2">
                <Badge
                  variant="outline"
                  className={cn('border-0 px-2 py-0.5 text-[11px] ring-1', severityTone(entry.meta.severity))}
                >
                  {entry.meta.severity.toFixed(1)}/10 · {outcome.severityLabel}
                </Badge>
                {outcome.vulnerable ? (
                  <Badge className="border-0 bg-red-500/15 px-2 py-0.5 text-[11px] text-red-300 ring-1 ring-red-500/25">
                    vulnerable
                  </Badge>
                ) : (
                  <Badge variant="outline" className="border-hairline px-2 py-0.5 text-[11px] text-muted-foreground">
                    clear
                  </Badge>
                )}
                {outcome.response && (
                  <Badge
                    variant="outline"
                    className={cn('border-0 px-2 py-0.5 font-mono text-[11px] ring-1', statusTone(outcome.response.status))}
                  >
                    {outcome.response.status}
                  </Badge>
                )}
              </div>
              <DialogTitle className="text-base leading-snug">{outcome.title}</DialogTitle>
              <DialogDescription className="text-xs leading-relaxed">{outcome.description}</DialogDescription>
            </DialogHeader>

            <div className="space-y-4">
              {outcome.evidence && (
                <Field label="Evidence — what the regex matched">
                  <CodeBlock text={outcome.evidence} tone="error" maxHeight="10rem" />
                </Field>
              )}

              <Field label="Request sent">
                <CodeBlock text={requestText} maxHeight="10rem" />
              </Field>

              {outcome.response && (
                <Field label={`Response — ${outcome.response.status} in ${outcome.response.durationMs}ms`}>
                  <CodeBlock text={outcome.response.bodyPreview || '(empty body)'} maxHeight="14rem" />
                </Field>
              )}

              <Field label="Reproduce it">
                <CodeBlock text={outcome.poc_curl} maxHeight="10rem" />
              </Field>

              <Field label="Detection regex">
                <CodeBlock text={outcome.regex} maxHeight="6rem" copyable={false} tone="muted" />
              </Field>

              {outcome.error && (
                <Field label="Error">
                  <CodeBlock text={outcome.error} tone="error" maxHeight="6rem" />
                </Field>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      {children}
    </div>
  )
}

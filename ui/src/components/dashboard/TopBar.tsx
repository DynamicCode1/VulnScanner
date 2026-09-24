import { ExternalLink, ListChecks, Loader2, Play, RotateCcw, ShieldCheck, Sparkles } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'

export type TabKey = 'checks' | 'report'

interface TopBarProps {
  target: string
  onTargetChange: (value: string) => void
  onRun: () => void
  running: boolean
  tab: TabKey
  onTabChange: (tab: TabKey) => void
  onReset: () => void
  surfaceLabel: string | null
  reportReady: boolean
}

export function TopBar({
  target,
  onTargetChange,
  onRun,
  running,
  tab,
  onTabChange,
  onReset,
  surfaceLabel,
  reportReady,
}: TopBarProps) {
  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-white/[0.07] bg-card/60 px-3 backdrop-blur">
      <div className="flex shrink-0 items-center gap-2 pl-1 pr-2">
        <div className="flex size-7 items-center justify-center rounded-lg bg-brand/15 ring-1 ring-brand/30">
          <ShieldCheck className="size-4 text-brand" />
        </div>
        <span className="hidden text-sm font-medium tracking-tight sm:block">SentinelAPI</span>
      </div>

      <div className="flex min-w-0 flex-1 items-center gap-2">
        <Input
          value={target}
          onChange={(event) => onTargetChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !running) onRun()
          }}
          spellCheck={false}
          className="h-9 max-w-xl flex-1 font-mono text-xs"
          placeholder="https://api.example.com"
        />

        <Button size="sm" onClick={onRun} disabled={running || !target.trim()} className="h-9 gap-1.5">
          {running ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
          {running ? 'Running' : 'Run'}
        </Button>

        {surfaceLabel && (
          <span className="hidden truncate text-xs text-muted-foreground lg:block">{surfaceLabel}</span>
        )}
      </div>

      <Tabs value={tab} onValueChange={(value) => onTabChange(value as TabKey)} className="shrink-0">
        <TabsList className="h-9">
          <TabsTrigger value="checks" className="gap-1.5 px-3 text-xs">
            <ListChecks className="size-3.5" />
            Checks
          </TabsTrigger>
          <TabsTrigger value="report" className="gap-1.5 px-3 text-xs">
            <Sparkles className={cn('size-3.5', reportReady && 'text-brand')} />
            Report
            {reportReady && <span className="size-1.5 rounded-full bg-brand" />}
          </TabsTrigger>
        </TabsList>
      </Tabs>

      <Button variant="ghost" size="icon" className="size-9 shrink-0" onClick={onReset} title="Start over">
        <RotateCcw className="size-4" />
      </Button>

      <a
        href="/report.html"
        target="_blank"
        rel="noreferrer"
        className={cn(
          'hidden shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground transition hover:text-foreground sm:flex',
          !reportReady && 'pointer-events-none opacity-30',
        )}
      >
        <ExternalLink className="size-3.5" />
        report.html
      </a>
    </header>
  )
}

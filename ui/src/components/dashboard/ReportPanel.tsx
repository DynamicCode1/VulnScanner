import { motion } from 'motion/react'
import { ExternalLink, FileText, Loader2, Sparkles } from 'lucide-react'
import { useState } from 'react'

import { Button, buttonVariants } from '@/components/ui/button'
import { streamSse } from '@/lib/api'
import { cn } from '@/lib/utils'

interface ReportPanelProps {
  target: string
  ready: boolean
  onReady: () => void
}

type ReportEvent =
  | { type: 'status'; text: string }
  | { type: 'done'; url: string; model: string; bytes: number }
  | { type: 'error'; message: string }

export function ReportPanel({ target, ready, onReady }: ReportPanelProps) {
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [result, setResult] = useState<{ url: string; model: string; bytes: number } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const generate = async () => {
    setBusy(true)
    setError(null)
    setStatus('Starting…')

    try {
      await streamSse<ReportEvent>('/api/report', { target }, (event) => {
        if (event.type === 'status') setStatus(event.text)
        else if (event.type === 'done') {
          setResult({ url: event.url, model: event.model, bytes: event.bytes })
          setStatus(null)
          onReady()
        } else if (event.type === 'error') setError(event.message)
      })
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  const hasReport = Boolean(result) || ready

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6">
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
        className="w-full max-w-lg rounded-2xl border border-white/[0.07] bg-white/[0.02] p-7 backdrop-blur"
      >
        <div className="mb-4 flex size-11 items-center justify-center rounded-xl border border-brand/25 bg-brand/10">
          <FileText className="size-5 text-brand" />
        </div>

        <h2 className="text-lg font-medium">Generate the report</h2>
        <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
          DeepSeek reads <span className="font-mono text-[11px] text-foreground/80">findings.md</span> and the static
          scan results, then writes a standalone{' '}
          <span className="font-mono text-[11px] text-foreground/80">report.html</span> — inline CSS, no external
          requests.
        </p>

        <div className="mt-5 flex flex-wrap items-center gap-2">
          <Button onClick={() => void generate()} disabled={busy || !target.trim()} className="gap-2">
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
            {busy ? 'Writing…' : hasReport ? 'Regenerate report' : 'Generate report.html'}
          </Button>

          {hasReport && (
            <a
              href="/report.html"
              target="_blank"
              rel="noreferrer"
              className={cn(buttonVariants({ variant: 'outline' }), 'gap-2')}
            >
              <ExternalLink className="size-4" />
              Open report
            </a>
          )}
        </div>

        {status && (
          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="mt-4 flex items-center gap-2 text-xs text-muted-foreground"
          >
            <span className="flex gap-1">
              {[0, 1, 2].map((index) => (
                <motion.span
                  key={index}
                  className="size-1.5 rounded-full bg-brand/70"
                  animate={{ opacity: [0.25, 1, 0.25] }}
                  transition={{ duration: 1.1, repeat: Infinity, delay: index * 0.18 }}
                />
              ))}
            </span>
            {status}
          </motion.p>
        )}

        {result && !busy && (
          <p className={cn('mt-4 text-xs text-brand')}>
            Written with {result.model} · {(result.bytes / 1024).toFixed(1)} KB
          </p>
        )}

        {error && <p className="mt-4 text-xs text-red-300">{error}</p>}

        <p className="mt-6 text-[11px] leading-relaxed text-muted-foreground/70">
          Best after the agent has run — findings.md is the evidence it quotes. Without it the report will say so
          rather than invent findings.
        </p>
      </motion.div>
    </div>
  )
}

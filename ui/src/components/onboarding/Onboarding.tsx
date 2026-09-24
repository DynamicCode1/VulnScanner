import { motion, AnimatePresence } from 'motion/react'
import { ArrowLeft, ArrowRight, FileJson, Globe, Loader2, ShieldCheck, TriangleAlert, Upload } from 'lucide-react'
import { useRef, useState } from 'react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { parseSpec } from '@/lib/api'
import type { Surface } from '@/lib/types'
import { cn } from '@/lib/utils'

interface OnboardingProps {
  onReady: (config: { target: string; surface: Surface | null }) => void
}

type Mode = 'spec' | 'url'

const panel =
  'rounded-2xl border border-hairline bg-panel p-6 backdrop-blur dark:shadow-[0_1px_0_0_rgba(255,255,255,0.04)_inset]'

export function Onboarding({ onReady }: OnboardingProps) {
  const [mode, setMode] = useState<Mode | null>(null)

  return (
    <div className="relative flex min-h-dvh items-center justify-center overflow-hidden bg-background px-6 py-12">
      <Backdrop />

      <div className="relative z-10 w-full max-w-5xl">
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
          className="mb-10 text-center"
        >
          <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-hairline bg-panel px-3 py-1 text-xs text-muted-foreground">
            <ShieldCheck className="size-3.5 text-brand" />
            Zero-trust API vulnerability scanner
          </div>
          <h1 className="text-balance text-4xl font-semibold tracking-tight sm:text-5xl">
            Find the API vulnerability before the breach headline does
          </h1>
          <p className="mx-auto mt-4 max-w-xl text-pretty text-sm text-muted-foreground">
            Point it at a spec or an origin. It runs the deterministic rule engine first, then hands the
            interesting parts to an agent.
          </p>
        </motion.div>

        <div className="relative">
          <AnimatePresence mode="wait" initial={false}>
            {mode === null && <ChooseStep key="choose" onPick={setMode} />}
            {mode === 'spec' && <SpecStep key="spec" onBack={() => setMode(null)} onReady={onReady} />}
            {mode === 'url' && <UrlStep key="url" onBack={() => setMode(null)} onReady={onReady} />}
          </AnimatePresence>
        </div>
      </div>
    </div>
  )
}

function Backdrop() {
  return (
    <>
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 [background-image:linear-gradient(to_right,var(--grid)_1px,transparent_1px),linear-gradient(to_bottom,var(--grid)_1px,transparent_1px)] [background-size:56px_56px]"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-0 h-[520px] w-[880px] -translate-x-1/2 rounded-full bg-brand/10 blur-[140px]"
      />
    </>
  )
}

function StepShell({
  children,
  className,
  delay = 0,
}: {
  children: React.ReactNode
  className?: string
  delay?: number
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1], delay }}
      className={className}
    >
      {children}
    </motion.div>
  )
}

function ChooseStep({ onPick }: { onPick: (mode: Mode) => void }) {
  const options = [
    {
      key: 'spec' as const,
      icon: FileJson,
      title: 'I have a spec',
      body: 'Upload an OpenAPI document and it becomes the site map — every documented route is enumerated.',
      cta: 'Select spec file',
    },
    {
      key: 'url' as const,
      icon: Globe,
      title: 'I have a URL',
      body: 'Start from an origin only. The built-in default surface is assumed and you can refine it later.',
      cta: 'Enter a URL',
    },
  ]

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {options.map((option, index) => (
        <StepShell key={option.key} delay={index * 0.06}>
          <motion.button
            type="button"
            onClick={() => onPick(option.key)}
            whileHover={{ y: -3 }}
            whileTap={{ scale: 0.99 }}
            transition={{ type: 'spring', stiffness: 420, damping: 30 }}
            className={cn(panel, 'group h-full w-full text-left transition-colors hover:border-brand/30')}
          >
            <div className="mb-4 inline-flex size-11 items-center justify-center rounded-xl border border-hairline bg-panel-2 transition-colors group-hover:border-brand/40 group-hover:bg-brand/10">
              <option.icon className="size-5 text-muted-foreground transition-colors group-hover:text-brand" />
            </div>
            <h2 className="text-lg font-medium">{option.title}</h2>
            <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{option.body}</p>
            <span className="mt-5 inline-flex items-center gap-1.5 text-sm font-medium text-brand">
              {option.cta}
              <ArrowRight className="size-4 transition-transform group-hover:translate-x-1" />
            </span>
          </motion.button>
        </StepShell>
      ))}
    </div>
  )
}

function StepHeader({ title, subtitle, onBack }: { title: string; subtitle: string; onBack: () => void }) {
  return (
    <div className="mb-5 flex items-start gap-3">
      <Button variant="ghost" size="icon" onClick={onBack} className="mt-0.5 size-8 shrink-0">
        <ArrowLeft className="size-4" />
      </Button>
      <div>
        <h2 className="text-lg font-medium">{title}</h2>
        <p className="text-sm text-muted-foreground">{subtitle}</p>
      </div>
    </div>
  )
}

function SpecStep({ onBack, onReady }: { onBack: () => void; onReady: OnboardingProps['onReady'] }) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [surface, setSurface] = useState<Surface | null>(null)
  const [target, setTarget] = useState('')

  const ingest = async (file: File) => {
    setBusy(true)
    setError(null)
    try {
      const parsed = await parseSpec(await file.text())
      setSurface(parsed)
      setTarget(parsed.baseUrl ?? '')
    } catch (caught) {
      setSurface(null)
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <StepShell className={cn(panel, 'mx-auto max-w-2xl')}>
      <StepHeader
        title="Load an OpenAPI document"
        subtitle="JSON only for now — a YAML spec gives a clear error rather than a silent failure."
        onBack={onBack}
      />

      {!surface && (
        <div
          onDragOver={(event) => {
            event.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault()
            setDragging(false)
            const file = event.dataTransfer.files?.[0]
            if (file) void ingest(file)
          }}
          onClick={() => inputRef.current?.click()}
          className={cn(
            'flex cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed px-6 py-12 text-center transition-colors',
            dragging ? 'border-brand/60 bg-brand/[0.06]' : 'border-hairline hover:border-white/20 hover:bg-panel',
          )}
        >
          {busy ? (
            <Loader2 className="size-6 animate-spin text-brand" />
          ) : (
            <Upload className="size-6 text-muted-foreground" />
          )}
          <p className="mt-3 text-sm font-medium">{busy ? 'Reading the document…' : 'Drop your spec here'}</p>
          <p className="mt-1 text-xs text-muted-foreground">or click to browse — openapi.json, swagger.json</p>
          <input
            ref={inputRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) void ingest(file)
            }}
          />
        </div>
      )}

      {error && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          className="mt-4 flex items-start gap-2 overflow-hidden rounded-lg border border-red-500/25 bg-red-500/[0.07] p-3 text-sm text-red-300"
        >
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </motion.div>
      )}

      {surface && (
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary" className="font-normal">
              {surface.title}
            </Badge>
            <Badge variant="outline" className="font-normal text-muted-foreground">
              v{surface.version}
            </Badge>
            <Badge variant="outline" className="font-normal text-brand">
              {surface.endpoints.length} endpoints
            </Badge>
          </div>

          <div className="max-h-56 overflow-auto rounded-lg border border-hairline bg-inset">
            {surface.endpoints.map((endpoint) => (
              <div
                key={`${endpoint.method}-${endpoint.path}`}
                className="flex items-center gap-3 border-b border-hairline px-3 py-1.5 last:border-0"
              >
                <span className="w-14 shrink-0 font-mono text-[11px] font-semibold text-brand">
                  {endpoint.method}
                </span>
                <span className="truncate font-mono text-xs text-muted-foreground">{endpoint.examplePath}</span>
              </div>
            ))}
          </div>

          <div className="space-y-2">
            <label htmlFor="target" className="text-xs font-medium text-muted-foreground">
              Origin to scan
            </label>
            <Input
              id="target"
              value={target}
              onChange={(event) => setTarget(event.target.value)}
              placeholder="http://127.0.0.1:5001"
              className="font-mono text-sm"
            />
          </div>

          <Button
            className="w-full"
            disabled={!target.trim()}
            onClick={() => onReady({ target: normalise(target), surface })}
          >
            Open the dashboard
            <ArrowRight className="size-4" />
          </Button>
        </motion.div>
      )}
    </StepShell>
  )
}

function UrlStep({ onBack, onReady }: { onBack: () => void; onReady: OnboardingProps['onReady'] }) {
  const [value, setValue] = useState('http://127.0.0.1:5001')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      // Ask the backend what surface it will assume, so the dashboard isn't guessing.
      const response = await fetch('/api/spec', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
      const body = (await response.json()) as Surface & { error?: string }
      if (!response.ok || body.error) throw new Error(body.error ?? 'Could not load the default surface.')
      onReady({ target: normalise(value), surface: body })
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
      setBusy(false)
    }
  }

  const invalid = !value.trim() || !/^https?:\/\//i.test(value.trim())

  return (
    <StepShell className={cn(panel, 'mx-auto max-w-2xl')}>
      <StepHeader
        title="Scan an origin"
        subtitle="No spec needed — the built-in default surface is assumed."
        onBack={onBack}
      />

      <div className="flex gap-2">
        <Input
          autoFocus
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !invalid) void submit()
          }}
          placeholder="https://api.example.com"
          className="font-mono text-sm"
        />
        <Button onClick={() => void submit()} disabled={invalid || busy}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : <ArrowRight className="size-4" />}
          Continue
        </Button>
      </div>

      {invalid && value.trim().length > 0 && (
        <p className="mt-2 text-xs text-amber-300">Include the scheme, e.g. http:// or https://</p>
      )}

      {error && <p className="mt-3 text-sm text-red-300">{error}</p>}
    </StepShell>
  )
}

function normalise(value: string): string {
  return value.trim().replace(/\/+$/, '')
}

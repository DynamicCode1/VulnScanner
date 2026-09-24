import { useCallback, useEffect, useRef, useState } from 'react'

import { streamSse } from '@/lib/api'
import type { CheckMeta, CheckOutcome, CheckState } from '@/lib/types'

/**
 * A real scan of a local target finishes in ~40ms — correct, but it reads as nothing
 * having happened. Rows are revealed one per tick instead, so the run looks like work
 * being done without slowing the scanner itself.
 */
const REVEAL_MS = 65

type ScanEvent =
  | { type: 'start'; total: number; checks: CheckMeta[] }
  | { type: 'running'; index: number }
  | { type: 'result'; index: number; result: CheckOutcome }
  | {
      type: 'done'
      summary: {
        total: number
        vulnerable: number
        clean: number
        errored: number
        highestSeverity: number
        bySeverity: Record<string, number>
      }
      durationMs: number
    }
  | { type: 'error'; message: string }

export interface ScanSummary {
  total: number
  vulnerable: number
  clean: number
  errored: number
  highestSeverity: number
  bySeverity: Record<string, number>
  durationMs: number
}

export function useScan() {
  const [metas, setMetas] = useState<CheckMeta[]>([])
  const [results, setResults] = useState<Record<number, CheckOutcome>>({})
  const [revealed, setRevealed] = useState(0)
  const [scanning, setScanning] = useState(false)
  const [summary, setSummary] = useState<ScanSummary | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** Which target the last run was against, so callers can tell whether results are current. */
  const [scannedTarget, setScannedTarget] = useState<string | null>(null)

  /** Indices the backend has actually answered — a row must not be revealed before this. */
  const received = useRef<Set<number>>(new Set())
  const streamDone = useRef(false)
  const pendingSummary = useRef<ScanSummary | null>(null)

  const run = useCallback(async (target: string) => {
    setScanning(true)
    setError(null)
    setSummary(null)
    setMetas([])
    setResults({})
    setRevealed(0)
    setScannedTarget(target.trim())
    received.current = new Set()
    streamDone.current = false
    pendingSummary.current = null

    try {
      await streamSse<ScanEvent>('/api/scan', { target }, (event) => {
        switch (event.type) {
          case 'start':
            setMetas(event.checks)
            break
          case 'result':
            received.current.add(event.index)
            setResults((previous) => ({ ...previous, [event.index]: event.result }))
            break
          case 'done':
            pendingSummary.current = { ...event.summary, durationMs: event.durationMs }
            streamDone.current = true
            break
          case 'error':
            setError(event.message)
            break
        }
      })
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setScanning(false)
      streamDone.current = true
    }
  }, [])

  const sweepComplete = metas.length === 0 || revealed >= metas.length

  // The reveal ticker. It advances one row per tick and stalls rather than lying: a row
  // is only revealed once its probe has actually come back.
  useEffect(() => {
    if (sweepComplete) return

    const timer = window.setInterval(() => {
      setRevealed((count) => {
        if (count >= metas.length) return count
        if (!received.current.has(count) && !streamDone.current) return count
        return count + 1
      })
    }, REVEAL_MS)

    return () => window.clearInterval(timer)
  }, [sweepComplete, metas.length])

  // Hold the result chips back until the sweep finishes, so the summary never lands
  // before the animation it describes.
  useEffect(() => {
    if (sweepComplete && pendingSummary.current) {
      setSummary(pendingSummary.current)
      pendingSummary.current = null
    }
  }, [sweepComplete])

  const checks: CheckState[] = metas.map((meta, index) => ({
    meta,
    status: index < revealed ? 'done' : index === revealed ? 'running' : 'queued',
    outcome: index < revealed ? results[index] : undefined,
  }))

  return { checks, running: scanning || !sweepComplete, summary, error, run, scannedTarget }
}

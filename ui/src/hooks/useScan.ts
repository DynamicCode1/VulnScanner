import { useCallback, useRef, useState } from 'react'

import { streamSse } from '@/lib/api'
import type { CheckMeta, CheckOutcome, CheckState } from '@/lib/types'

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
  const [checks, setChecks] = useState<CheckState[]>([])
  const [running, setRunning] = useState(false)
  const [summary, setSummary] = useState<ScanSummary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const completed = useRef(0)

  const run = useCallback(async (target: string) => {
    setRunning(true)
    setSummary(null)
    setError(null)
    setChecks([])
    completed.current = 0

    try {
      await streamSse<ScanEvent>('/api/scan', { target }, (event) => {
        switch (event.type) {
          case 'start':
            setChecks(event.checks.map((meta) => ({ meta, status: 'queued' as const })))
            break
          case 'running':
            setChecks((previous) =>
              previous.map((entry) =>
                entry.meta.index === event.index ? { ...entry, status: 'running' as const } : entry,
              ),
            )
            break
          case 'result':
            completed.current += 1
            setChecks((previous) =>
              previous.map((entry) =>
                entry.meta.index === event.index
                  ? { ...entry, status: 'done' as const, outcome: event.result }
                  : entry,
              ),
            )
            break
          case 'done':
            setSummary({ ...event.summary, durationMs: event.durationMs })
            break
          case 'error':
            setError(event.message)
            break
        }
      })
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setRunning(false)
    }
  }, [])

  return { checks, running, summary, error, run }
}

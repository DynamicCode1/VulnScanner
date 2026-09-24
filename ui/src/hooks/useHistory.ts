import { useCallback, useEffect, useRef, useState } from 'react'

import { clearHistory, fetchHistory } from '@/lib/api'
import type { HistoryEntry } from '@/lib/types'

/**
 * Polls while something is in flight, otherwise only on demand — the log is append-only,
 * so there is nothing to learn from polling a quiet system.
 */
export function useHistory(active: boolean) {
  const [entries, setEntries] = useState<HistoryEntry[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const inFlight = useRef(false)

  const refresh = useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true
    try {
      setEntries(await fetchHistory())
    } catch {
      // A failed poll is not worth surfacing; the next one will probably work.
    } finally {
      inFlight.current = false
    }
  }, [])

  /** Wipes the log on the server, then reloads the (now empty) list. */
  const reset = useCallback(async () => {
    try {
      await clearHistory()
    } catch {
      // If the clear fails the refresh below still shows whatever is there.
    }
    setSelected(null)
    setEntries([])
    await refresh()
  }, [refresh])

  // A dashboard session starts empty. The file is a real audit trail on the server, but
  // carrying a previous session's probes into a fresh one is just noise — and it made the
  // history look persistent across refreshes.
  useEffect(() => {
    void reset()
  }, [reset])

  useEffect(() => {
    if (!active) return
    const timer = window.setInterval(() => void refresh(), 1500)
    return () => window.clearInterval(timer)
  }, [active, refresh])

  const selectedEntry = entries.find((entry) => entry.id === selected) ?? null

  return { entries, selected, selectedEntry, setSelected, refresh, reset }
}

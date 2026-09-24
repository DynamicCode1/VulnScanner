import { useCallback, useEffect, useRef, useState } from 'react'

import { fetchHistory } from '@/lib/api'
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

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (!active) return
    const timer = window.setInterval(() => void refresh(), 1500)
    return () => window.clearInterval(timer)
  }, [active, refresh])

  const selectedEntry = entries.find((entry) => entry.id === selected) ?? null

  return { entries, selected, selectedEntry, setSelected, refresh }
}

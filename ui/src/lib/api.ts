import type { HistoryEntry, ReportData, Surface } from './types'

/**
 * Reads a `text/event-stream` response, calling `onEvent` for every `data:` payload.
 *
 * Heartbeat comments (`: ping`) are skipped — they exist only to keep the connection
 * alive while a model call is silent.
 */
export async function streamSse<T>(
  path: string,
  body: unknown,
  onEvent: (event: T) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    let message = `${response.status} ${response.statusText}`
    try {
      const parsed = JSON.parse(text) as { error?: string }
      if (parsed.error) message = parsed.error
    } catch {
      if (text) message = text
    }
    throw new Error(message)
  }

  if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'text/event-stream') {
    throw new Error('The server did not return an event stream.')
  }
  if (!response.body) throw new Error('The server returned no stream.')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  const cancelReader = () => { void reader.cancel().catch(() => {}) }
  signal?.addEventListener('abort', cancelReader, { once: true })

  try {
    for (;;) {
      signal?.throwIfAborted()
      const { done, value } = await reader.read()
      signal?.throwIfAborted()
      if (done) break

      buffer += decoder.decode(value, { stream: true })

      let boundary = buffer.indexOf('\n\n')
      while (boundary !== -1) {
        const chunk = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)

        for (const line of chunk.split('\n')) {
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          if (!payload) continue
          let event: T
          try {
            event = JSON.parse(payload) as T
          } catch {
            throw new Error('The server returned an invalid event.')
          }
          onEvent(event)
          signal?.throwIfAborted()
        }

        boundary = buffer.indexOf('\n\n')
      }
    }
  } finally {
    signal?.removeEventListener('abort', cancelReader)
    cancelReader()
    reader.releaseLock()
  }
}

export async function parseSpec(text: string): Promise<Surface> {
  const response = await fetch('/api/spec', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ spec: text }),
  })
  const body = (await response.json()) as Surface & { error?: string }
  if (!response.ok || body.error) throw new Error(body.error ?? 'Could not read that spec.')
  return body
}

export async function fetchHistory(kind?: 'http' | 'llm'): Promise<HistoryEntry[]> {
  const query = kind ? `?kind=${kind}&order=desc&limit=400` : '?order=desc&limit=400'
  const response = await fetch(`/api/history${query}`)
  const body = (await response.json()) as { entries?: HistoryEntry[] }
  return body.entries ?? []
}

export async function clearHistory(): Promise<void> {
  await fetch('/api/history', { method: 'DELETE' })
}

/** The last generated report, or null when none exists yet. */
export async function fetchReport(signal?: AbortSignal): Promise<ReportData | null> {
  const response = await fetch('/api/report', { signal })
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`Could not load the saved report (${response.status}).`)
  const report = await response.json() as ReportData | null
  if (!report || typeof report.meta?.target !== 'string') {
    throw new Error('The saved report is invalid. Please generate a new report.')
  }
  return report
}

import type { HistoryEntry, Surface } from './types'

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

  if (!response.body) throw new Error('The server returned no stream.')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  for (;;) {
    const { done, value } = await reader.read()
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
        try {
          onEvent(JSON.parse(payload) as T)
        } catch {
          // A malformed frame is not worth killing the stream over.
        }
      }

      boundary = buffer.indexOf('\n\n')
    }
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

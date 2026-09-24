import { useCallback, useRef, useState } from 'react'

import { streamSse } from '@/lib/api'
import type { AgentRunSummary, ChatMessage } from '@/lib/types'

type AgentEvent =
  | { type: 'session'; sessionId: string; target: string; restored: number }
  | { type: 'delta'; text: string }
  | { type: 'log'; line: string }
  | ({ type: 'done' } & AgentRunSummary)
  | { type: 'error'; message: string }

/** Banner lines the runner prints once; not useful as chat rows. */
const BANNER = /^(Target|Findings|Model|Context|Budget|Session)\s/

export function useAgent() {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [running, setRunning] = useState(false)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [summary, setSummary] = useState<AgentRunSummary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const counter = useRef(0)

  const nextId = () => `m${++counter.current}`

  const send = useCallback(async (target: string, message?: string, session?: string | null) => {
    setRunning(true)
    setError(null)
    if (message) {
      setMessages((previous) => [...previous, { id: nextId(), role: 'user', text: message }])
    }

    // Token deltas arrive as many small chunks; keep one assistant row open and append.
    let openId: string | null = null

    try {
      await streamSse<AgentEvent>(
        '/api/agent',
        { target, message, sessionId: session ?? undefined },
        (event) => {
          switch (event.type) {
            case 'session':
              setSessionId(event.sessionId)
              break
            case 'delta': {
              const id = openId ?? nextId()
              openId = id
              setMessages((previous) => {
                const existing = previous.find((entry) => entry.id === id)
                if (!existing) return [...previous, { id, role: 'assistant', text: event.text, streaming: true }]
                return previous.map((entry) =>
                  entry.id === id ? { ...entry, text: entry.text + event.text } : entry,
                )
              })
              break
            }
            case 'log': {
              const line = event.line.trim()
              if (!line || BANNER.test(line)) return
              openId = null
              setMessages((previous) => [...previous, { id: nextId(), role: 'tool', text: line }])
              break
            }
            case 'done':
              setSummary({
                sessionId: event.sessionId,
                findings: event.findings,
                turns: event.turns,
                stopped: event.stopped,
                messages: event.messages,
                error: event.error,
              })
              if (event.error) setError(event.error)
              break
            case 'error':
              setError(event.message)
              break
          }
        },
      )
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setMessages((previous) => previous.map((entry) => ({ ...entry, streaming: false })))
      setRunning(false)
    }
  }, [])

  const reset = useCallback(() => {
    setMessages([])
    setSummary(null)
    setError(null)
    setSessionId(null)
  }, [])

  return { messages, running, sessionId, summary, error, send, reset }
}

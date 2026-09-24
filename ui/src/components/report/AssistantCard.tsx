import { motion } from 'motion/react'
import { Bot, CornerDownLeft, Loader2, Sparkles } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { MessageRow } from '@/components/dashboard/AgentPanel'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import type { ChatMessage } from '@/lib/types'
import { cn } from '@/lib/utils'

interface AssistantCardProps {
  messages: ChatMessage[]
  running: boolean
  error: string | null
  onAsk: (prompt: string) => void
  suggestions?: string[]
}

const DEFAULT_SUGGESTIONS = [
  'Explain the most serious finding',
  'How do I fix the critical ones?',
  'Are there similar issues elsewhere?',
  'Draft a ticket for the worst finding',
]

export function AssistantCard({ messages, running, error, onAsk, suggestions = DEFAULT_SUGGESTIONS }: AssistantCardProps) {
  const [draft, setDraft] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)
  const started = messages.length > 0

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages])

  const submit = () => {
    const text = draft.trim()
    if (!text || running) return
    setDraft('')
    onAsk(text)
  }

  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-hairline bg-panel">
      <div className="flex shrink-0 items-center gap-2 border-b border-hairline px-4 py-3">
        <div className="flex size-6 items-center justify-center rounded-md bg-brand/10 ring-1 ring-brand/25">
          <Bot className="size-3.5 text-brand" />
        </div>
        <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          AI security assistant
        </h3>
        {running && <Loader2 className="ml-auto size-3 animate-spin text-brand" />}
      </div>

      {!started ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4">
          <p className="text-[11.5px] leading-relaxed text-muted-foreground">
            Ask about any finding, endpoint or the report as a whole. It already has the scan and the confirmed
            findings in context.
          </p>

          <div className="mt-3 space-y-1.5">
            {suggestions.map((suggestion, index) => (
              <motion.button
                key={suggestion}
                type="button"
                initial={{ opacity: 0, x: -4 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.2, delay: index * 0.05 }}
                disabled={running}
                onClick={() => onAsk(suggestion)}
                className="flex w-full items-center gap-2 rounded-lg border border-hairline bg-panel px-2.5 py-2 text-left text-[11.5px] text-muted-foreground transition-colors hover:border-hairline hover:bg-panel-2 hover:text-foreground disabled:opacity-50"
              >
                <Sparkles className="size-3 shrink-0 text-brand/70" />
                {suggestion}
              </motion.button>
            ))}
          </div>

          {error && <p className="mt-3 text-[11px] text-red-300">{error}</p>}
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <div className="flex flex-col gap-3">
            {messages.map((message) => (
              <MessageRow key={message.id} message={message} />
            ))}
            {running && (
              <div className="flex items-center gap-2 px-1 text-[11px] text-muted-foreground">
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
                working
              </div>
            )}
            <div ref={bottomRef} />
          </div>
        </div>
      )}

      <div className="shrink-0 border-t border-hairline p-2.5">
        <div className="relative">
          <Textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                submit()
              }
            }}
            rows={2}
            placeholder="Ask anything…"
            className={cn('resize-none pr-10 text-xs')}
          />
          <Button
            size="icon"
            variant="ghost"
            onClick={submit}
            disabled={running || !draft.trim()}
            className="absolute bottom-1.5 right-1.5 size-7"
          >
            <CornerDownLeft className="size-3.5" />
          </Button>
        </div>
      </div>
    </section>
  )
}

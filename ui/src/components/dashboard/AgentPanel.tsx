import { motion } from 'motion/react'
import { Bot, CornerDownLeft, Loader2, Play, Sparkles, SquareTerminal, User } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Textarea } from '@/components/ui/textarea'
import type { AgentRunSummary, ChatMessage } from '@/lib/types'
import { cn } from '@/lib/utils'

interface AgentPanelProps {
  messages: ChatMessage[]
  running: boolean
  summary: AgentRunSummary | null
  error: string | null
  onStart: () => void
  onSend: (message: string) => void
  /** Overridable so the report can reuse this panel as a Q&A box over the same session. */
  title?: string
  startLabel?: string
  startHint?: string
  startHeadline?: string
  placeholder?: string
}

export function AgentPanel({
  messages,
  running,
  summary,
  error,
  onStart,
  onSend,
  title = 'Agent',
  startLabel = 'Run AI agent for vulnerability finding',
  startHint = 'It probes the target, chains requests to confirm logic flaws, and records what it proves.',
  startHeadline = 'Hand it to the agent',
  placeholder = 'Ask about a finding, or tell it what to test next…',
}: AgentPanelProps) {
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
    onSend(text)
  }

  return (
    <section className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-hairline px-3 py-2">
        <div className="flex items-center gap-2">
          <Bot className="size-3.5 text-brand" />
          <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</h2>
          {running && <Loader2 className="size-3 animate-spin text-brand" />}
        </div>

        {summary && (
          <div className="flex items-center gap-1.5">
            <span className="rounded-full bg-brand/15 px-2 py-0.5 text-[11px] font-medium text-brand ring-1 ring-brand/25">
              {summary.findings} finding{summary.findings === 1 ? '' : 's'}
            </span>
            <span className="font-mono text-[11px] text-muted-foreground">
              {summary.turns} turns · {summary.stopped}
            </span>
          </div>
        )}
      </div>

      {!started ? (
        <StartPrompt
          onStart={onStart}
          running={running}
          error={error}
          label={startLabel}
          hint={startHint}
          headline={startHeadline}
        />
      ) : (
        <>
          <ScrollArea className="min-h-0 flex-1">
            <div className="flex flex-col gap-3 p-3">
              {messages.map((message) => (
                <MessageRow key={message.id} message={message} />
              ))}
              {running && (
                <div className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
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
          </ScrollArea>

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
                placeholder={placeholder}
                className="resize-none pr-10 text-xs"
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
            <p className="mt-1.5 px-1 text-[11px] text-muted-foreground">
              Enter to send · Shift+Enter for a new line
            </p>
          </div>
        </>
      )}
    </section>
  )
}

function StartPrompt({
  onStart,
  running,
  error,
  label,
  hint,
  headline,
}: {
  onStart: () => void
  running: boolean
  error: string | null
  label: string
  hint: string
  headline: string
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
      <motion.div
        initial={{ scale: 0.9, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: 'spring', stiffness: 320, damping: 24 }}
        className="flex size-12 items-center justify-center rounded-2xl border border-brand/25 bg-brand/10"
      >
        <Sparkles className="size-5 text-brand" />
      </motion.div>

      <div className="space-y-1">
        <p className="text-sm font-medium">{headline}</p>
        <p className="max-w-xs text-xs leading-relaxed text-muted-foreground">{hint}</p>
      </div>

      <motion.div whileHover={{ y: -2 }} whileTap={{ scale: 0.98 }}>
        <Button onClick={onStart} disabled={running} className="gap-2">
          {running ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
          {running ? 'Working…' : label}
        </Button>
      </motion.div>

      {error && <p className="max-w-sm text-xs text-red-300">{error}</p>}
    </div>
  )
}

export function MessageRow({ message }: { message: ChatMessage }) {
  if (message.role === 'tool') {
    return (
      <motion.div
        initial={{ opacity: 0, x: -4 }}
        animate={{ opacity: 1, x: 0 }}
        className="flex items-start gap-2 rounded-md border border-hairline bg-inset px-2.5 py-1.5"
      >
        <SquareTerminal className="mt-0.5 size-3 shrink-0 text-brand/70" />
        <span className="min-w-0 flex-1 break-words font-mono text-[11px] leading-relaxed text-muted-foreground">
          {message.text}
        </span>
      </motion.div>
    )
  }

  const isUser = message.role === 'user'

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
      className={cn('flex gap-2', isUser && 'flex-row-reverse')}
    >
      <div
        className={cn(
          'mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md ring-1',
          isUser ? 'bg-panel-2 ring-hairline' : 'bg-brand/10 ring-brand/25',
        )}
      >
        {isUser ? <User className="size-3 text-muted-foreground" /> : <Bot className="size-3 text-brand" />}
      </div>

      <div
        className={cn(
          'min-w-0 max-w-[88%] rounded-xl px-3 py-2 text-xs leading-relaxed',
          isUser ? 'bg-panel-3 text-foreground' : 'bg-panel ring-1 ring-hairline',
        )}
      >
        {isUser ? (
          <p className="whitespace-pre-wrap break-words">{message.text}</p>
        ) : (
          <div className="markdown">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.text}</ReactMarkdown>
            {message.streaming && <span className="ml-0.5 inline-block h-3 w-1.5 animate-pulse bg-brand/80" />}
          </div>
        )}
      </div>
    </motion.div>
  )
}

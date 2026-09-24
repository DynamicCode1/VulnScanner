import { motion } from 'motion/react'
import { ArrowUpRight, Bot, MousePointerClick, Trash2 } from 'lucide-react'
import { useState } from 'react'

import { CodeBlock } from '@/components/shared/CodeBlock'
import { Button } from '@/components/ui/button'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { ScrollArea } from '@/components/ui/scroll-area'
import { clearHistory } from '@/lib/api'
import { shortPath, statusTone } from '@/lib/severity'
import type { HistoryEntry } from '@/lib/types'
import { cn } from '@/lib/utils'

interface HistoryPanelProps {
  entries: HistoryEntry[]
  selected: HistoryEntry | null
  onSelect: (id: string | null) => void
  onCleared: () => void
}

export function HistoryPanel({ entries, selected, onSelect, onCleared }: HistoryPanelProps) {
  const [clearing, setClearing] = useState(false)

  const wipe = async () => {
    setClearing(true)
    try {
      await clearHistory()
      onSelect(null)
      onCleared()
    } finally {
      setClearing(false)
    }
  }

  return (
    <section className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-hairline px-3 py-2">
        <div className="flex items-center gap-2">
          <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">History</h2>
          <span className="font-mono text-[11px] text-muted-foreground">{entries.length}</span>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          title="Clear history"
          disabled={clearing || entries.length === 0}
          onClick={() => void wipe()}
        >
          <Trash2 className="size-3.5" />
        </Button>
      </div>

      {/* Remounting on shape change keeps the resizer from holding stale layout state
          when the detail panel appears or disappears. */}
      <ResizablePanelGroup
        key={selected ? 'split' : 'single'}
        orientation="vertical"
        className="min-h-0 flex-1"
      >
        <ResizablePanel defaultSize={selected ? '42%' : '100%'} minSize="18%" className="min-h-0 overflow-hidden">
          <ScrollArea className="h-full">
            {entries.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 px-6 py-12 text-center">
                <MousePointerClick className="size-5 text-muted-foreground/50" />
                <p className="text-xs text-muted-foreground">
                  Nothing yet. Every probe the scanner and the agent send lands here.
                </p>
              </div>
            ) : (
              <ul className="p-1">
                {entries.map((entry) => (
                  <HistoryRow
                    key={entry.id}
                    entry={entry}
                    active={selected?.id === entry.id}
                    onClick={() => onSelect(selected?.id === entry.id ? null : entry.id)}
                  />
                ))}
              </ul>
            )}
          </ScrollArea>
        </ResizablePanel>

        {selected && (
          <>
            <ResizableHandle withHandle />
            <ResizablePanel defaultSize="58%" minSize="18%" className="min-h-0 overflow-hidden">
              <ScrollArea className="h-full">
                <ExchangeDetail entry={selected} />
              </ScrollArea>
            </ResizablePanel>
          </>
        )}
      </ResizablePanelGroup>
    </section>
  )
}

function HistoryRow({ entry, active, onClick }: { entry: HistoryEntry; active: boolean; onClick: () => void }) {
  const isLlm = entry.kind === 'llm'
  const path = isLlm ? `${entry.request.model}` : shortPath(entry.request.url)
  const method = isLlm ? 'LLM' : entry.request.method

  return (
    <li>
      <motion.button
        type="button"
        onClick={onClick}
        whileTap={{ scale: 0.995 }}
        className={cn(
          'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors',
          active ? 'bg-brand/[0.09] ring-1 ring-brand/25' : 'hover:bg-panel-2',
        )}
      >
        <span
          className={cn(
            'w-12 shrink-0 font-mono text-[11px] font-semibold',
            isLlm ? 'text-brand' : 'text-muted-foreground',
          )}
        >
          {method}
        </span>

        {isLlm ? (
          <span className="flex shrink-0 items-center gap-1 rounded-full bg-brand/12 px-1.5 py-0.5 text-[11px] text-brand ring-1 ring-brand/20">
            <Bot className="size-2.5" />
            model
          </span>
        ) : entry.response ? (
          // Prefer the real status: a non-zero curl exit can still carry a full response,
          // and showing ERR there would misrepresent what happened.
          <span
            className={cn(
              'shrink-0 rounded-full px-1.5 py-0.5 font-mono text-[11px] ring-1',
              statusTone(entry.response.status),
            )}
          >
            {entry.response.status}
          </span>
        ) : (
          <span className="shrink-0 rounded-full bg-red-500/15 px-1.5 py-0.5 font-mono text-[11px] text-red-300 ring-1 ring-red-500/25">
            ERR
          </span>
        )}

        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">{path}</span>
      </motion.button>
    </li>
  )
}

function ExchangeDetail({ entry }: { entry: HistoryEntry }) {
  if (entry.kind === 'llm') return <LlmDetail entry={entry} />

  const requestHeaders = Object.entries(entry.request.headers)
    .map(([name, value]) => `${name}: ${value}`)
    .join('\n')

  const requestText = [
    `${entry.request.method} ${entry.request.url}`,
    requestHeaders,
    '',
    entry.request.body ?? '',
  ]
    .filter((part) => part !== '')
    .join('\n')

  const responseHeaders = Object.entries(entry.response?.headers ?? {})
    .map(([name, value]) => `${name}: ${value}`)
    .join('\n')

  return (
    <div className="space-y-4 p-3">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Request</p>
      <CodeBlock text={requestText} maxHeight="12rem" />

      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
        Response{entry.response ? ` · ${entry.response.status} ${entry.response.statusText}` : ''}
      </p>

      {entry.error && <CodeBlock text={entry.error} tone="error" maxHeight="6rem" />}

      {entry.response && (
        <>
          <CodeBlock text={responseHeaders || '(no headers)'} tone="muted" maxHeight="10rem" />
          <CodeBlock text={entry.response.bodyPreview || '(empty body)'} maxHeight="18rem" />
          <p className="font-mono text-[11px] text-muted-foreground">
            {entry.response.bodyBytes} bytes · {entry.response.durationMs}ms
          </p>
        </>
      )}
    </div>
  )
}

function LlmDetail({ entry }: { entry: Extract<HistoryEntry, { kind: 'llm' }> }) {
  const content = (entry.response?.content ?? []) as Array<{ type?: string; text?: string; name?: string }>

  return (
    <div className="space-y-4 p-3">
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
        <span className="font-mono">{entry.request.provider}</span>
        <ArrowUpRight className="size-3" />
        <span className="font-mono text-brand">{entry.request.model}</span>
        <span>· {entry.request.messages.length} messages in context</span>
      </div>

      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Model response</p>

      {entry.error && <CodeBlock text={entry.error} tone="error" maxHeight="6rem" />}

      {content.length === 0 && !entry.error && (
        <p className="text-xs text-muted-foreground">No content recorded.</p>
      )}

      {content.map((block, index) => (
        <div key={index} className="space-y-1.5">
          <p className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
            {block.type === 'toolCall' ? `tool call · ${block.name}` : block.type}
          </p>
          <CodeBlock
            text={block.text ?? JSON.stringify(block, null, 2)}
            maxHeight="14rem"
            tone={block.type === 'toolCall' ? 'muted' : 'default'}
          />
        </div>
      ))}

      {entry.response?.stopReason && (
        <p className="font-mono text-[11px] text-muted-foreground">
          stop: {entry.response.stopReason} · {entry.response.durationMs}ms
        </p>
      )}
    </div>
  )
}

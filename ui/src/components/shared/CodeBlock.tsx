import { Check, Copy } from 'lucide-react'
import { useState } from 'react'

import { cn } from '@/lib/utils'

interface CodeBlockProps {
  text: string
  tone?: 'default' | 'error' | 'muted'
  className?: string
  maxHeight?: string
  /** Hide the copy button for very short inline snippets. */
  copyable?: boolean
}

export function CodeBlock({ text, tone = 'default', className, maxHeight = '18rem', copyable = true }: CodeBlockProps) {
  const [copied, setCopied] = useState(false)

  const copy = () => {
    void navigator.clipboard.writeText(text)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1200)
  }

  return (
    <div className={cn('group relative rounded-lg border border-white/[0.06] bg-black/40', className)}>
      {copyable && (
        <button
          type="button"
          onClick={copy}
          aria-label="Copy"
          className="absolute right-2 top-2 rounded-md border border-white/10 bg-white/[0.06] p-1.5 text-muted-foreground opacity-0 transition hover:bg-white/10 hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
        >
          {copied ? <Check className="size-3.5 text-brand" /> : <Copy className="size-3.5" />}
        </button>
      )}
      <pre
        style={{ maxHeight }}
        className={cn(
          'overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-[12px] leading-relaxed',
          tone === 'error' && 'text-red-300',
          tone === 'muted' && 'text-muted-foreground',
        )}
      >
        {text}
      </pre>
    </div>
  )
}

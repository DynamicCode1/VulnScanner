import { motion } from 'motion/react'
import { CircleSlash, ExternalLink, ShieldAlert, Wrench, X } from 'lucide-react'

import { CodeBlock } from '@/components/shared/CodeBlock'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { severityHex } from '@/lib/severity'
import type { ReportData, ReportFinding } from '@/lib/types'
import { cn } from '@/lib/utils'

interface ReportDetailProps {
  data: ReportData
  finding: ReportFinding | null
  onClose: () => void
}

export function ReportDetail({ data, finding, onClose }: ReportDetailProps) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-hairline px-3 py-2">
        <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {finding ? 'Finding detail' : 'Overview'}
        </h2>
        {finding && (
          <Button variant="ghost" size="icon" className="size-6" onClick={onClose} title="Back to overview">
            <X className="size-3.5" />
          </Button>
        )}
      </div>

      <ScrollArea className="min-h-0 flex-1">
        {finding ? <FindingBody finding={finding} /> : <OverviewBody data={data} />}
      </ScrollArea>
    </div>
  )
}

function FindingBody({ finding }: { finding: ReportFinding }) {
  const tone = severityHex(finding.severity)

  const meta = [
    { label: 'Endpoint', value: `${finding.method} ${finding.endpoint}`, mono: true },
    { label: 'Type', value: finding.category },
    { label: 'Confidence', value: finding.confidence },
    { label: 'OWASP', value: finding.owasp },
    { label: 'CWE', value: finding.cwe },
  ].filter((row) => row.value)

  return (
    <motion.div
      key={finding.id}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
      className="space-y-4 p-3"
    >
      <div>
        <Badge
          variant="outline"
          className="mb-2 border-0 px-2 py-0.5 text-[10px] font-semibold"
          style={{ color: tone, backgroundColor: `${tone}22`, boxShadow: `inset 0 0 0 1px ${tone}55` }}
        >
          {finding.severity}
        </Badge>
        <h3 className="text-sm font-medium leading-snug">{finding.title}</h3>
      </div>

      <dl className="space-y-1.5 rounded-lg border border-hairline bg-panel p-2.5">
        {meta.map((row) => (
          <div key={row.label} className="flex gap-2 text-[11px]">
            <dt className="w-20 shrink-0 text-muted-foreground">{row.label}</dt>
            <dd className={cn('min-w-0 flex-1 break-words', row.mono && 'font-mono')}>{row.value}</dd>
          </div>
        ))}
      </dl>

      {finding.impact && (
        <Section icon={ShieldAlert} label="Impact">
          <p className="text-[11.5px] leading-relaxed text-muted-foreground">{finding.impact}</p>
        </Section>
      )}

      {finding.evidence && (
        <Section icon={ExternalLink} label="Evidence">
          <CodeBlock text={finding.evidence} tone="error" maxHeight="18rem" />
        </Section>
      )}

      {finding.remediation && (
        <Section icon={Wrench} label="Remediation">
          <p className="text-[11.5px] leading-relaxed text-muted-foreground">{finding.remediation}</p>
        </Section>
      )}
    </motion.div>
  )
}

function OverviewBody({ data }: { data: ReportData }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
      className="space-y-4 p-3"
    >
      <div>
        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Verdict</p>
        <p className="mt-1 text-xs leading-relaxed">{data.meta.verdict}</p>
      </div>

      {data.meta.summary && (
        <div>
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Executive summary</p>
          <p className="mt-1 text-[11.5px] leading-relaxed text-muted-foreground">{data.meta.summary}</p>
        </div>
      )}

      <dl className="space-y-1.5 rounded-lg border border-hairline bg-panel p-2.5">
        {[
          { label: 'Target', value: data.meta.target, mono: true },
          { label: 'Generated', value: new Date(data.meta.generatedAt).toLocaleString(), mono: false },
          { label: 'Model', value: data.meta.model, mono: true },
        ].map((row) => (
          <div key={row.label} className="flex gap-2 text-[11px]">
            <dt className="w-20 shrink-0 text-muted-foreground">{row.label}</dt>
            <dd className={cn('min-w-0 flex-1 break-words', row.mono && 'font-mono')}>{row.value}</dd>
          </div>
        ))}
      </dl>

      <div className="flex items-start gap-2 rounded-lg border border-hairline bg-panel p-2.5">
        <CircleSlash className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Select a finding from the list to see its evidence, impact and fix here.
        </p>
      </div>
    </motion.div>
  )
}

function Section({
  icon: Icon,
  label,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        <Icon className="size-3" />
        {label}
      </p>
      {children}
    </div>
  )
}

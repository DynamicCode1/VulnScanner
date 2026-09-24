import { motion } from 'motion/react'
import { ChevronRight, Filter, Search, ShieldAlert } from 'lucide-react'
import { useMemo, useState } from 'react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { severityHex } from '@/lib/severity'
import type { ReportFilter, ReportFinding } from '@/lib/types'
import { cn } from '@/lib/utils'

interface ReportFindingsProps {
  findings: ReportFinding[]
  selectedId: string | null
  onSelect: (finding: ReportFinding) => void
  filter: ReportFilter | null
  onClearFilter: () => void
  /** Preview mode for the overview: no search, capped rows, plus a "view all" action. */
  compact?: boolean
  onViewAll?: () => void
}

export function ReportFindings({
  findings,
  selectedId,
  onSelect,
  filter,
  onClearFilter,
  compact = false,
  onViewAll,
}: ReportFindingsProps) {
  const [query, setQuery] = useState('')

  const matched = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return findings.filter((finding) => {
      if (filter?.kind === 'severity' && finding.severity !== filter.value) return false
      if (filter?.kind === 'category' && finding.category !== filter.value) return false
      if (!needle) return true
      return `${finding.title} ${finding.endpoint} ${finding.category} ${finding.impact}`
        .toLowerCase()
        .includes(needle)
    })
  }, [findings, filter, query])

  const rows = compact ? matched.slice(0, 6) : matched

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-hairline px-4 py-2.5">
        {!compact && (
          <>
            <div className="relative w-full max-w-xs">
              <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Filter findings…"
                className="h-8 pl-8 text-xs"
              />
            </div>

            <span className="font-mono text-[11px] text-muted-foreground">
              {rows.length}/{findings.length}
            </span>
          </>
        )}

        {compact && (
          <span className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            <ShieldAlert className="size-3.5" />
            Recent vulnerabilities
          </span>
        )}

        {filter && (
          <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }}>
            <Button variant="secondary" size="sm" onClick={onClearFilter} className="h-7 gap-1.5 text-[11px]">
              <Filter className="size-3" />
              {filter.kind === 'severity' ? 'Severity' : 'Type'}: {filter.value}
              <span className="text-muted-foreground">✕</span>
            </Button>
          </motion.div>
        )}

        {compact && matched.length > 6 && onViewAll && (
          <Button variant="link" size="sm" onClick={onViewAll} className="ml-auto h-7 px-1.5 text-[11px]">
            View all {matched.length}
          </Button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {rows.length === 0 ? (
          <p className="px-4 py-10 text-center text-xs text-muted-foreground">No findings match this filter.</p>
        ) : (
          <Table>
            <TableHeader className={cn('bg-background/95 backdrop-blur', !compact && 'sticky top-0 z-10')}>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-[92px]">Severity</TableHead>
                <TableHead>Vulnerability</TableHead>
                <TableHead className={cn('w-[240px]', compact ? 'hidden 2xl:table-cell' : 'hidden lg:table-cell')}>
                  Endpoint
                </TableHead>
                <TableHead className={cn('w-[160px]', compact ? 'hidden' : 'hidden xl:table-cell')}>Type</TableHead>
                <TableHead className="w-8" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((finding) => (
                <TableRow
                  key={finding.id}
                  onClick={() => onSelect(finding)}
                  className={cn(
                    'cursor-pointer transition-colors',
                    selectedId === finding.id ? 'bg-panel-2' : 'hover:bg-panel',
                  )}
                >
                  <TableCell className="py-2">
                    <Badge
                      variant="outline"
                      className="border-0 px-2 py-0.5 text-[10px] font-semibold"
                      style={{
                        color: severityHex(finding.severity),
                        backgroundColor: `${severityHex(finding.severity)}22`,
                        boxShadow: `inset 0 0 0 1px ${severityHex(finding.severity)}55`,
                      }}
                    >
                      {finding.severity}
                    </Badge>
                  </TableCell>
                  <TableCell className="py-2">
                    <span className="line-clamp-1 text-xs">{finding.title}</span>
                    <span className="mt-0.5 block font-mono text-[10px] text-muted-foreground lg:hidden">
                      {finding.method} {finding.endpoint}
                    </span>
                  </TableCell>
                  <TableCell className={cn('py-2', compact ? 'hidden 2xl:table-cell' : 'hidden lg:table-cell')}>
                    <span className="line-clamp-1 font-mono text-[11px] text-muted-foreground">
                      {finding.method} {finding.endpoint}
                    </span>
                  </TableCell>
                  <TableCell className={cn('py-2', compact ? 'hidden' : 'hidden xl:table-cell')}>
                    <span className="line-clamp-1 text-[11px] text-muted-foreground">{finding.category}</span>
                  </TableCell>
                  <TableCell className="py-2">
                    <ChevronRight
                      className={cn(
                        'size-3.5 transition-transform',
                        selectedId === finding.id ? 'text-foreground' : 'text-muted-foreground/30',
                      )}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  )
}

/** Mirrors the thresholds in src/staticChecker.tsx so chips agree with the backend. */
export function severityLabel(score: number): 'Critical' | 'High' | 'Medium' | 'Low' | 'Info' {
  if (score >= 9) return 'Critical'
  if (score >= 7) return 'High'
  if (score >= 4) return 'Medium'
  if (score >= 1) return 'Low'
  return 'Info'
}

const TONE: Record<string, string> = {
  Critical: 'bg-red-500/15 text-red-300 ring-red-500/30',
  High: 'bg-orange-500/15 text-orange-300 ring-orange-500/30',
  Medium: 'bg-amber-500/15 text-amber-300 ring-amber-500/30',
  Low: 'bg-sky-500/15 text-sky-300 ring-sky-500/30',
  Info: 'bg-white/5 text-muted-foreground ring-white/10',
}

export function severityTone(score: number): string {
  return TONE[severityLabel(score)] ?? TONE.Info
}

/** Colour for an HTTP status, LeetCode-submission style. */
export function statusTone(status: number): string {
  if (status >= 200 && status < 300) return 'bg-brand/15 text-brand ring-brand/30'
  if (status >= 300 && status < 400) return 'bg-sky-500/15 text-sky-300 ring-sky-500/30'
  if (status >= 400 && status < 500) return 'bg-amber-500/15 text-amber-300 ring-amber-500/30'
  if (status >= 500) return 'bg-red-500/15 text-red-300 ring-red-500/30'
  return 'bg-white/5 text-muted-foreground ring-white/10'
}

export function shortPath(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.pathname}${parsed.search}`
  } catch {
    return url
  }
}

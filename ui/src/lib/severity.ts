/** Mirrors the thresholds in src/staticChecker.tsx so chips agree with the backend. */
export function severityLabel(score: number): 'Critical' | 'High' | 'Medium' | 'Low' | 'Info' {
  if (score >= 9) return 'Critical'
  if (score >= 7) return 'High'
  if (score >= 4) return 'Medium'
  if (score >= 1) return 'Low'
  return 'Info'
}

/**
 * `dark:` variants throughout: a 300-level tint reads well on a dark panel but washes out
 * on white, so each tone pairs a deep shade for light mode with the pastel for dark.
 */
const TONE: Record<string, string> = {
  Critical: 'bg-red-500/10 text-red-700 ring-red-500/25 dark:bg-red-500/15 dark:text-red-300 dark:ring-red-500/30',
  High: 'bg-orange-500/10 text-orange-700 ring-orange-500/25 dark:bg-orange-500/15 dark:text-orange-300 dark:ring-orange-500/30',
  Medium: 'bg-amber-500/10 text-amber-700 ring-amber-500/25 dark:bg-amber-500/15 dark:text-amber-300 dark:ring-amber-500/30',
  Low: 'bg-sky-500/10 text-sky-700 ring-sky-500/25 dark:bg-sky-500/15 dark:text-sky-300 dark:ring-sky-500/30',
  Info: 'bg-panel text-muted-foreground ring-hairline',
}

export function severityTone(score: number): string {
  return TONE[severityLabel(score)] ?? TONE.Info
}

/** Colour for an HTTP status, LeetCode-submission style. */
export function statusTone(status: number): string {
  if (status >= 200 && status < 300) return 'bg-brand/15 text-brand ring-brand/30'
  if (status >= 300 && status < 400) return 'bg-sky-500/10 text-sky-700 ring-sky-500/25 dark:bg-sky-500/15 dark:text-sky-300 dark:ring-sky-500/30'
  if (status >= 400 && status < 500) return 'bg-amber-500/10 text-amber-700 ring-amber-500/25 dark:bg-amber-500/15 dark:text-amber-300 dark:ring-amber-500/30'
  if (status >= 500) return 'bg-red-500/10 text-red-700 ring-red-500/25 dark:bg-red-500/15 dark:text-red-300 dark:ring-red-500/30'
  return 'bg-panel text-muted-foreground ring-hairline'
}

export function shortPath(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.pathname}${parsed.search}`
  } catch {
    return url
  }
}

/**
 * Literal values for chart fills — recharts and SVG need a concrete colour, not a class.
 * These are the 500-level shades so they hold up on both a white and a near-black panel.
 */
const SEVERITY_HEX: Record<string, string> = {
  Critical: '#ef4444',
  High: '#f97316',
  Medium: '#f59e0b',
  Low: '#3b82f6',
  Info: '#9ca3af',
}

export function severityHex(severity: string): string {
  return SEVERITY_HEX[severity] ?? SEVERITY_HEX.Info
}

/** Tone for the big score chip, and the ring colour for the gauge. */
export function scoreTone(score: number): { text: string; bg: string; ring: string; solid: string } {
  if (score >= 80) return { text: 'text-brand', bg: 'bg-brand/10', ring: 'ring-brand/25', solid: '#10b981' }
  if (score >= 60)
    return {
      text: 'text-amber-700 dark:text-amber-300',
      bg: 'bg-amber-500/10',
      ring: 'ring-amber-500/25',
      solid: '#f59e0b',
    }
  if (score >= 40)
    return {
      text: 'text-orange-700 dark:text-orange-300',
      bg: 'bg-orange-500/10',
      ring: 'ring-orange-500/25',
      solid: '#f97316',
    }
  return {
    text: 'text-red-700 dark:text-red-300',
    bg: 'bg-red-500/10',
    ring: 'ring-red-500/25',
    solid: '#ef4444',
  }
}

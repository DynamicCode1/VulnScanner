import { StrictMode, type ComponentProps } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ReportDashboard } from './ReportDashboard'
import { fetchReport, streamSse } from '@/lib/api'
import type { ReportData } from '@/lib/types'

vi.mock('@/lib/api', () => ({ fetchReport: vi.fn(), streamSse: vi.fn() }))
vi.mock('@/components/dashboard/HistoryPanel', () => ({ HistoryPanel: () => null }))
vi.mock('@/components/report/AssistantCard', () => ({ AssistantCard: () => null }))
vi.mock('@/components/report/ReportDetail', () => ({ ReportDetail: () => null }))
vi.mock('@/components/report/ReportFindings', () => ({ ReportFindings: () => null }))
vi.mock('@/components/report/ReportCards', () => ({
  ActivityCard: () => null,
  CoverageCard: () => null,
  DistributionCard: () => null,
  RecommendationsCard: () => null,
  StatCards: () => null,
  TopTypesCard: () => null,
}))

const target = 'http://localhost:3000'
const report: ReportData = {
  meta: { target, title: 'Completed report', verdict: 'Review findings', summary: '', generatedAt: '', model: 'test' },
  score: { value: 0, grade: 'A', rationale: '' },
  stats: { endpointsExplored: 1, vulnerabilitiesFound: 0, bySeverity: { Critical: 0, High: 0, Medium: 0, Low: 0, Info: 0 } },
  distribution: [], topTypes: [], findings: [], coverage: { tested: [], notCovered: [] }, recommendations: [],
}

function props(nextTarget = target): ComponentProps<typeof ReportDashboard> {
  return {
    target: nextTarget,
    scan: {
      scannedTarget: nextTarget, running: false, checks: [], error: null, run: vi.fn(),
      summary: { total: 1, vulnerable: 0, clean: 1, errored: 0, highestSeverity: 0, bySeverity: {}, durationMs: 1 },
    },
    history: { entries: [], selected: null, selectedEntry: null, setSelected: vi.fn(), refresh: vi.fn(), reset: vi.fn() },
    agent: { messages: [], running: false, summary: null, error: null, sessionId: null, send: vi.fn(), reset: vi.fn() },
    onReady: vi.fn(),
  }
}

async function flush() {
  await act(async () => { await Promise.resolve() })
}

beforeEach(() => {
  vi.mocked(fetchReport).mockReset().mockResolvedValue(null)
  vi.mocked(streamSse).mockReset().mockImplementation(async (_path, _body, onEvent) => {
    onEvent({ type: 'done', data: report } as never)
  })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('report request lifecycle', () => {
  it('does not repeat initialization on an ordinary rerender', async () => {
    const input = props()
    const view = render(<ReportDashboard {...input} />)
    await flush()
    view.rerender(<ReportDashboard {...input} />)
    await flush()
    expect(fetchReport).toHaveBeenCalledTimes(1)
    expect(streamSse).toHaveBeenCalledTimes(1)
  })

  it('shows cache errors without silently generating', async () => {
    vi.mocked(fetchReport).mockRejectedValue(new Error('Cache unavailable'))
    render(<ReportDashboard {...props()} />)
    await flush()
    expect(screen.getByText('Cache unavailable')).toBeTruthy()
    expect(streamSse).not.toHaveBeenCalled()
  })

  it.each(['empty', 'status-only'])('reports %s EOF and allows retry', async (kind) => {
    vi.mocked(streamSse).mockImplementationOnce(async (_path, _body, onEvent) => {
      if (kind === 'status-only') onEvent({ type: 'status', text: 'Working' } as never)
    })
    render(<ReportDashboard {...props()} />)
    await flush()
    expect(screen.getByText(/ended before a report was received/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await flush()
    expect(screen.getByRole('heading', { name: report.meta.title })).toBeTruthy()
  })

  it('shows an explicit generation error', async () => {
    vi.mocked(streamSse).mockImplementation(async (_path, _body, onEvent) => {
      onEvent({ type: 'error', message: 'Provider unavailable' } as never)
    })
    render(<ReportDashboard {...props()} />)
    await flush()
    expect(screen.getByText('Provider unavailable')).toBeTruthy()
  })

  it('preserves a report and displays regeneration errors', async () => {
    vi.mocked(fetchReport).mockResolvedValue(report)
    vi.mocked(streamSse).mockRejectedValue(new Error('Regeneration failed'))
    render(<ReportDashboard {...props()} />)
    await flush()
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }))
    await flush()
    expect(screen.getByRole('heading', { name: report.meta.title })).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toBe('Regeneration failed')
    expect((screen.getByRole('button', { name: 'Regenerate' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('aborts a stalled cache lookup and offers retry', async () => {
    vi.useFakeTimers()
    vi.mocked(fetchReport).mockImplementation(() => new Promise(() => {}))
    render(<StrictMode><ReportDashboard {...props()} /></StrictMode>)
    await flush()
    expect(fetchReport).toHaveBeenCalledTimes(1)
    const signal = vi.mocked(fetchReport).mock.calls[0][0]
    expect(signal?.aborted).toBe(false)
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
    expect(signal?.aborted).toBe(true)
    expect(screen.getByText(/saved report timed out/)).toBeTruthy()
    expect(streamSse).not.toHaveBeenCalled()
  })

  it('bounds generation even when statuses keep arriving and ignores late completion', async () => {
    vi.useFakeTimers()
    let emit: (event: unknown) => void = () => {}
    vi.mocked(streamSse).mockImplementation((_path, _body, onEvent) => {
      emit = onEvent
      return new Promise(() => {})
    })
    const input = props()
    render(<ReportDashboard {...input} />)
    await flush()
    await act(async () => { await vi.advanceTimersByTimeAsync(90_000) })
    act(() => emit({ type: 'status', text: 'Still working' }))
    await act(async () => { await vi.advanceTimersByTimeAsync(90_000) })
    expect(screen.getByText(/Report generation timed out/)).toBeTruthy()
    expect(vi.mocked(streamSse).mock.calls[0][3]?.aborted).toBe(true)
    act(() => emit({ type: 'done', data: report }))
    expect(input.onReady).not.toHaveBeenCalled()
    expect(screen.queryByRole('heading', { name: report.meta.title })).toBeNull()
  })

  it('aborts generation on unmount and ignores its late result', async () => {
    let emit: (event: unknown) => void = () => {}
    vi.mocked(streamSse).mockImplementation((_path, _body, onEvent) => {
      emit = onEvent
      return new Promise(() => {})
    })
    const input = props()
    const view = render(<ReportDashboard {...input} />)
    await flush()
    view.unmount()
    expect(vi.mocked(streamSse).mock.calls[0][3]?.aborted).toBe(true)
    act(() => emit({ type: 'done', data: report }))
    expect(input.onReady).not.toHaveBeenCalled()
  })

  it('ignores stale cached results after a target change', async () => {
    let resolveOld: (value: ReportData) => void = () => {}
    vi.mocked(fetchReport).mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve }))
    const input = props()
    const view = render(<ReportDashboard {...input} />)
    await flush()
    const next = props('http://localhost:3001')
    const nextReport = { ...report, meta: { ...report.meta, target: next.target, title: 'New target report' } }
    vi.mocked(fetchReport).mockResolvedValue(nextReport)
    view.rerender(<ReportDashboard {...next} />)
    await flush()
    await act(async () => { resolveOld(report) })
    expect(screen.getByRole('heading', { name: 'New target report' })).toBeTruthy()
    expect(input.onReady).not.toHaveBeenCalled()
    expect(next.onReady).toHaveBeenCalledTimes(1)
    expect(streamSse).not.toHaveBeenCalled()
  })

  it('clears old report content while the next target loads', async () => {
    vi.mocked(fetchReport).mockResolvedValueOnce(report)
    const view = render(<ReportDashboard {...props()} />)
    await flush()
    vi.mocked(fetchReport).mockImplementation(() => new Promise(() => {}))
    view.rerender(<ReportDashboard {...props('http://localhost:3001')} />)
    expect(screen.queryByRole('heading', { name: report.meta.title })).toBeNull()
  })
})

describe('report initialization', () => {
  it('starts generation after StrictMode replays a completed-scan mount', async () => {
    const input = props()
    render(<StrictMode><ReportDashboard {...input} /></StrictMode>)
    await flush()
    expect(streamSse).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('heading', { name: report.meta.title })).toBeTruthy()
    expect(input.onReady).toHaveBeenCalledTimes(1)
  })

  it('loads a matching cached report under StrictMode without generating', async () => {
    vi.mocked(fetchReport).mockResolvedValue(report)
    render(<StrictMode><ReportDashboard {...props()} /></StrictMode>)
    await flush()
    expect(screen.getByRole('heading', { name: report.meta.title })).toBeTruthy()
    expect(streamSse).not.toHaveBeenCalled()
  })
})

import { useCallback, useState } from 'react'

import { AgentPanel } from '@/components/dashboard/AgentPanel'
import { HistoryPanel } from '@/components/dashboard/HistoryPanel'
import { ReportPanel } from '@/components/dashboard/ReportPanel'
import { TestsPanel } from '@/components/dashboard/TestsPanel'
import { TopBar, type TabKey } from '@/components/dashboard/TopBar'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { useAgent } from '@/hooks/useAgent'
import { useHistory } from '@/hooks/useHistory'
import { useScan } from '@/hooks/useScan'
import type { Surface } from '@/lib/types'

interface DashboardProps {
  initialTarget: string
  surface: Surface | null
  onReset: () => void
}

/** react-resizable-panels v4 reads bare numbers as pixels, so sizes are explicit percentages. */
const PANEL = 'min-h-0 overflow-hidden'

export function Dashboard({ initialTarget, surface, onReset }: DashboardProps) {
  const [target, setTarget] = useState(initialTarget)
  const [tab, setTab] = useState<TabKey>('checks')
  const [reportReady, setReportReady] = useState(false)

  const scan = useScan()
  const agent = useAgent()
  const history = useHistory(scan.running || agent.running)

  const busy = scan.running || agent.running

  const runScan = useCallback(() => {
    if (!target.trim()) return
    setTab('checks')
    void scan.run(target.trim())
  }, [scan, target])

  const startAgent = useCallback(() => {
    if (!target.trim()) return
    void agent.send(target.trim())
  }, [agent, target])

  const sendChat = useCallback(
    (message: string) => {
      void agent.send(target.trim(), message, agent.sessionId)
    },
    [agent, target],
  )

  const surfaceLabel = surface ? `${surface.title} · ${surface.endpoints.length} endpoints` : null

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-background">
      <TopBar
        target={target}
        onTargetChange={setTarget}
        onRun={runScan}
        running={busy}
        tab={tab}
        onTabChange={setTab}
        onReset={onReset}
        surfaceLabel={surfaceLabel}
        reportReady={reportReady}
      />

      {tab === 'report' ? (
        <ReportPanel target={target} ready={reportReady} onReady={() => setReportReady(true)} />
      ) : (
        <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
          {/* Left column: tests on top, agent underneath — the LeetCode split. */}
          <ResizablePanel defaultSize="62%" minSize="30%" className={PANEL}>
            <ResizablePanelGroup orientation="vertical">
              <ResizablePanel defaultSize="54%" minSize="18%" className={PANEL}>
                <TestsPanel
                  checks={scan.checks}
                  running={scan.running}
                  summary={scan.summary}
                  error={scan.error}
                />
              </ResizablePanel>
              <ResizableHandle withHandle />
              <ResizablePanel defaultSize="46%" minSize="18%" className={PANEL}>
                <AgentPanel
                  messages={agent.messages}
                  running={agent.running}
                  summary={agent.summary}
                  error={agent.error}
                  onStart={startAgent}
                  onSend={sendChat}
                />
              </ResizablePanel>
            </ResizablePanelGroup>
          </ResizablePanel>

          <ResizableHandle withHandle />

          <ResizablePanel defaultSize="38%" minSize="22%" className={PANEL}>
            <HistoryPanel
              entries={history.entries}
              selected={history.selectedEntry}
              onSelect={history.setSelected}
              onCleared={() => void history.refresh()}
            />
          </ResizablePanel>
        </ResizablePanelGroup>
      )}
    </div>
  )
}

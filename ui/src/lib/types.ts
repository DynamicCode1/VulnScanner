export interface ApiEndpoint {
  method: string
  path: string
  examplePath: string
  operationId?: string
  summary?: string
}

export interface Surface {
  title: string
  version: string
  baseUrl: string | null
  endpoints: ApiEndpoint[]
}

export interface CheckMeta {
  index: number
  title: string
  description: string
  severity: number
}

export interface ExecutedRequest {
  method: string
  url: string
  headers: Record<string, string>
  body?: string
}

export interface ExecutedResponse {
  status: number
  statusText: string
  headers: Record<string, string>
  bodyBytes: number
  durationMs: number
  bodyPreview: string
}

export interface CheckOutcome {
  id: string
  title: string
  description: string
  severity: number
  severityLabel: string
  vulnerable: boolean
  regex: string
  request: ExecutedRequest
  response?: ExecutedResponse
  evidence?: string
  poc_curl: string
  error?: string
}

export type CheckStatus = 'queued' | 'running' | 'done'

export interface CheckState {
  meta: CheckMeta
  status: CheckStatus
  outcome?: CheckOutcome
}

export type HistoryKind = 'http' | 'llm'

export interface HttpHistoryEntry {
  kind: 'http'
  id: string
  ts: string
  request: ExecutedRequest
  response: ExecutedResponse | null
  error?: string
}

export interface LlmHistoryEntry {
  kind: 'llm'
  id: string
  ts: string
  sessionId?: string
  request: { provider: string; model: string; messages: unknown[]; toolCount: number }
  response: { content: unknown[]; stopReason?: string; usage?: unknown; durationMs: number } | null
  error?: string
}

export type HistoryEntry = HttpHistoryEntry | LlmHistoryEntry

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'tool'
  text: string
  streaming?: boolean
}

export interface AgentRunSummary {
  sessionId: string
  findings: number
  turns: number
  stopped: string
  messages: number
  error?: string
}

/* ---------------------------------------------------------------- report */

export const SEVERITIES = ['Critical', 'High', 'Medium', 'Low', 'Info'] as const
export type Severity = (typeof SEVERITIES)[number]

export interface ReportFinding {
  id: string
  title: string
  severity: Severity
  category: string
  method: string
  endpoint: string
  impact: string
  evidence: string
  remediation: string
  owasp: string
  cwe: string
  confidence: 'High' | 'Medium' | 'Low'
}

/** Which slice the report is currently filtered to, driven by clicking a chart. */
export interface ReportFilter {
  kind: 'severity' | 'category'
  value: string
}

export interface ReportData {
  meta: {
    target: string
    title: string
    verdict: string
    summary: string
    generatedAt: string
    model: string
  }
  score: { value: number; grade: string; rationale: string }
  stats: {
    endpointsExplored: number
    vulnerabilitiesFound: number
    bySeverity: Record<Severity, number>
  }
  distribution: Array<{ severity: Severity; count: number }>
  topTypes: Array<{ type: string; count: number; description: string }>
  findings: ReportFinding[]
  coverage: { tested: string[]; notCovered: string[] }
  recommendations: Array<{ priority: string; action: string }>
}

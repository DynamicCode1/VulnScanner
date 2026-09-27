/**
 * Turns a finished assessment into structured report data.
 *
 * The model's job is to FILL A SCHEMA, not to write a document. Freeform HTML meant the
 * output could not be laid out, sorted or interacted with; JSON means the dashboard can
 * render it properly and `report.html` can be generated from the same data with no
 * second model call.
 *
 * Inputs are `findings.md` (what the agent confirmed with evidence) and the static rules
 * report (what the deterministic engine found).
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createDeepSeek } from "./agent";

export const REPORT_PATH = process.env.REPORT_HTML ?? "report.html";
/**
 * A second, always-present copy of the export. It is rewritten on EVERY generation —
 * including when the model is unreachable — so a demo can open `/final-report.html`
 * without depending on DeepSeek at request time.
 */
export const FINAL_REPORT_PATH = process.env.FINAL_REPORT_PATH ?? "final-report.html";
export const REPORT_JSON = process.env.REPORT_JSON ?? "data/report.json";

/** Enough to describe everything, bounded so the request stays cheap. */
const MAX_INPUT_CHARS = 30_000;

export const SEVERITIES = ["Critical", "High", "Medium", "Low", "Info"] as const;
export type Severity = (typeof SEVERITIES)[number];

export interface ReportFinding {
  id: string;
  title: string;
  severity: Severity;
  category: string;
  method: string;
  endpoint: string;
  impact: string;
  evidence: string;
  remediation: string;
  owasp: string;
  cwe: string;
  confidence: "High" | "Medium" | "Low";
}

export interface ReportData {
  meta: {
    target: string;
    title: string;
    verdict: string;
    summary: string;
    generatedAt: string;
    model: string;
  };
  score: {
    value: number;
    grade: string;
    rationale: string;
  };
  stats: {
    endpointsExplored: number;
    vulnerabilitiesFound: number;
    bySeverity: Record<Severity, number>;
  };
  /** Always derived from `stats.bySeverity` so the chart can never disagree with the chips. */
  distribution: Array<{ severity: Severity; count: number }>;
  topTypes: Array<{ type: string; count: number; description: string }>;
  findings: ReportFinding[];
  coverage: { tested: string[]; notCovered: string[] };
  recommendations: Array<{ priority: string; action: string }>;
}

export interface ReportInput {
  target: string;
  findingsPath?: string;
  staticReport?: unknown;
}

const SYSTEM_PROMPT = `You are a security analyst producing the data behind an assessment dashboard. You are filling a schema, not writing prose.

Reply with ONE JSON object and nothing else. No markdown fence, no commentary before or after. The first character must be "{".

Shape (every key is required):

{
  "title": string,
  "verdict": string,                 // ONE sentence, the headline finding
  "summary": string,                 // 3-5 sentences an engineer can act on
  "score": {
    "value": number,                 // integer 0-100, security posture
    "rationale": string              // one sentence explaining the score
  },
  "stats": {
    "endpointsExplored": number,     // distinct endpoints actually probed
    "bySeverity": { "Critical": number, "High": number, "Medium": number, "Low": number, "Info": number }
  },
  "topTypes": [                      // 3-6 recurring vulnerability classes, most common first
    { "type": string, "count": number, "description": string }
  ],
  "findings": [
    {
      "title": string,
      "severity": "Critical" | "High" | "Medium" | "Low" | "Info",
      "category": string,            // e.g. "BOLA", "Excessive data exposure", "Security misconfiguration"
      "method": string,              // e.g. "GET"
      "endpoint": string,            // e.g. "/api/orders/1"
      "impact": string,              // one or two sentences on what an attacker gains
      "evidence": string,            // the real request/response proof, copied from findings.md VERBATIM
      "remediation": string,         // the concrete fix
      "owasp": string,               // e.g. "API1:2023 BOLA", or "" if unsure
      "cwe": string,                 // e.g. "CWE-639", or "" if unsure
      "confidence": "High" | "Medium" | "Low"
    }
  ],
  "coverage": {
    "tested": string[],              // short phrases: what was actually exercised
    "notCovered": string[]           // honest gaps: unfilled placeholder routes, checks that could not run, TLS, etc.
  },
  "recommendations": [
    { "priority": string, "action": string }   // "Immediate" | "Short term" | "Hardening"
  ]
}

Scoring rubric — start at 100 and subtract, then clamp to 0-100:
  Critical -25, High -15, Medium -6, Low -2, Info 0.
Adjust by at most 10 either way for context (unauthenticated access to sensitive data is worse than the raw count suggests; a lab target with no production data is less severe).

Rules:
- Derive findings from findings.md. That is the evidence of record — copy its evidence text verbatim, do not paraphrase or invent.
- If findings.md is empty, fall back to the static rule results and say so in "coverage.notCovered".
- Never invent endpoints, response bodies or evidence that is not in the inputs.
- "endpointsExplored" counts distinct endpoints actually touched, not the size of the API surface.
- Order "findings" most severe first.
- Be specific and technical. This is read by engineers.`;

const DEFAULT_SCORE_CAP = 100;

/* ------------------------------------------------------------- normalising */

function asString(value: unknown, fallback = ""): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number") return String(value);
  return fallback;
}

function asCount(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : 0;
}

function asSeverity(value: unknown): Severity {
  const text = asString(value).toLowerCase();
  if (text.startsWith("crit")) return "Critical";
  if (text.startsWith("high")) return "High";
  if (text.startsWith("med")) return "Medium";
  if (text.startsWith("low")) return "Low";
  return "Info";
}

function asConfidence(value: unknown): ReportFinding["confidence"] {
  const text = asString(value).toLowerCase();
  if (text.startsWith("high")) return "High";
  if (text.startsWith("low")) return "Low";
  return "Medium";
}

function asStringList(value: unknown, limit = 40): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => asString(entry)).filter(Boolean).slice(0, limit);
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "finding"
  );
}

function gradeFor(score: number): string {
  if (score >= 90) return "A";
  if (score >= 80) return "B";
  if (score >= 70) return "C";
  if (score >= 55) return "D";
  if (score >= 40) return "E";
  return "F";
}

/** Models sometimes fence JSON or add a sentence. Take the outermost object. */
function extractJson(reply: string): unknown {
  let text = reply.trim();

  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(text);
  if (fenced?.[1]) text = fenced[1].trim();

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("The model did not return a JSON object.");
  return JSON.parse(text.slice(start, end + 1));
}

function normalize(raw: Record<string, unknown>, target: string, model: string): ReportData {
  const scoreSource = (raw.score ?? {}) as Record<string, unknown>;
  const statsSource = (raw.stats ?? {}) as Record<string, unknown>;
  const severitySource = (statsSource.bySeverity ?? {}) as Record<string, unknown>;

  const scoreValue = Math.min(Math.max(asCount(scoreSource.value), 0), DEFAULT_SCORE_CAP);

  const findings: ReportFinding[] = (Array.isArray(raw.findings) ? raw.findings : []).map((entry, index) => {
    const item = (entry ?? {}) as Record<string, unknown>;
    const title = asString(item.title, `Finding ${index + 1}`);
    return {
      id: slugify(title),
      title,
      severity: asSeverity(item.severity),
      category: asString(item.category, "Uncategorised"),
      method: asString(item.method, "GET").toUpperCase(),
      endpoint: asString(item.endpoint, "/"),
      impact: asString(item.impact),
      evidence: asString(item.evidence),
      remediation: asString(item.remediation),
      owasp: asString(item.owasp),
      cwe: asString(item.cwe),
      confidence: asConfidence(item.confidence),
    };
  });

  const bySeverity = Object.fromEntries(
    SEVERITIES.map((severity) => [severity, asCount(severitySource[severity])]),
  ) as Record<Severity, number>;

  // Trust the findings list over the model's own tally when they disagree.
  if (findings.length > 0) {
    const counted = Object.fromEntries(SEVERITIES.map((severity) => [severity, 0])) as Record<Severity, number>;
    for (const finding of findings) counted[finding.severity] += 1;
    for (const severity of SEVERITIES) {
      if (counted[severity] > 0) bySeverity[severity] = counted[severity];
    }
  }

  const vulnerabilitiesFound = findings.length || SEVERITIES.reduce((total, s) => total + bySeverity[s], 0);

  return {
    meta: {
      target,
      title: asString(raw.title, "API Security Assessment"),
      verdict: asString(raw.verdict, "Review the findings below."),
      summary: asString(raw.summary),
      generatedAt: new Date().toISOString(),
      model,
    },
    score: {
      value: scoreValue,
      grade: gradeFor(scoreValue),
      rationale: asString(scoreSource.rationale),
    },
    stats: {
      endpointsExplored: asCount(statsSource.endpointsExplored),
      vulnerabilitiesFound,
      bySeverity,
    },
    distribution: SEVERITIES.map((severity) => ({ severity, count: bySeverity[severity] })),
    topTypes: (Array.isArray(raw.topTypes) ? raw.topTypes : []).slice(0, 8).map((entry) => {
      const item = (entry ?? {}) as Record<string, unknown>;
      return {
        type: asString(item.type, "Uncategorised"),
        count: asCount(item.count),
        description: asString(item.description),
      };
    }),
    findings,
    coverage: {
      tested: asStringList((raw.coverage as Record<string, unknown>)?.tested),
      notCovered: asStringList((raw.coverage as Record<string, unknown>)?.notCovered),
    },
    recommendations: (Array.isArray(raw.recommendations) ? raw.recommendations : []).slice(0, 12).map((entry) => {
      const item = (entry ?? {}) as Record<string, unknown>;
      return { priority: asString(item.priority, "Hardening"), action: asString(item.action) };
    }),
  };
}

/* -------------------------------------------------------------------- html */

const SEVERITY_COLOR: Record<Severity, string> = {
  Critical: "#f87171",
  High: "#fb923c",
  Medium: "#fbbf24",
  Low: "#60a5fa",
  Info: "#9a9aa5",
};

function escapeHtml(value: string): string {
  return value.replace(/[<>&]/g, (char) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[char]!);
}

/** Deterministic export — same data as the dashboard, no extra model call. */
export function renderReportHtml(data: ReportData, note?: string): string {
  const chips = SEVERITIES.filter((severity) => data.stats.bySeverity[severity] > 0)
    .map(
      (severity) =>
        `<span class="chip" style="--c:${SEVERITY_COLOR[severity]}">${severity} ${data.stats.bySeverity[severity]}</span>`,
    )
    .join("");

  const findings = data.findings
    .map(
      (finding) => `<section class="card">
  <div class="row">
    <span class="chip" style="--c:${SEVERITY_COLOR[finding.severity]}">${finding.severity}</span>
    <strong>${escapeHtml(finding.title)}</strong>
  </div>
  <p class="muted">${escapeHtml(finding.method)} ${escapeHtml(finding.endpoint)} · ${escapeHtml(finding.category)}${finding.owasp ? ` · ${escapeHtml(finding.owasp)}` : ""}</p>
  ${finding.impact ? `<p>${escapeHtml(finding.impact)}</p>` : ""}
  ${finding.evidence ? `<pre>${escapeHtml(finding.evidence)}</pre>` : ""}
  ${finding.remediation ? `<p><strong>Fix:</strong> ${escapeHtml(finding.remediation)}</p>` : ""}
</section>`,
    )
    .join("\n");

  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(data.meta.title)} — ${escapeHtml(data.meta.target)}</title>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:#0b0b0f;color:#e7e7ea;font:15px/1.65 system-ui,-apple-system,'Segoe UI',sans-serif}
main{max-width:900px;margin:0 auto;padding:40px 24px}
h1{font-size:1.6rem;letter-spacing:-.02em;margin:0 0 .35rem}
h2{font-size:1.05rem;margin:2.2rem 0 .7rem;padding-bottom:.35rem;border-bottom:1px solid #ffffff1a}
.muted{color:#9a9aa5}
.chip{display:inline-block;padding:2px 9px;border-radius:999px;font-size:12px;font-weight:600;
  color:var(--c);background:color-mix(in oklab, var(--c) 16%, transparent);border:1px solid color-mix(in oklab, var(--c) 35%, transparent)}
.row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.stats{display:flex;gap:12px;flex-wrap:wrap;margin:18px 0}
.stat{background:#14141b;border:1px solid #ffffff14;border-radius:12px;padding:14px 18px;min-width:150px}
.stat b{display:block;font-size:1.6rem;line-height:1.2}
.card{background:#14141b;border:1px solid #ffffff14;border-radius:12px;padding:16px;margin:12px 0}
pre{background:#0b0b0f;border:1px solid #ffffff14;border-radius:8px;padding:12px;overflow:auto;
  font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;word-break:break-word}
ul{margin:.4rem 0;padding-left:1.2rem}
</style></head><body><main>
<h1>${escapeHtml(data.meta.title)}</h1>
<p class="muted">${escapeHtml(data.meta.target)} · generated ${escapeHtml(data.meta.generatedAt)} with ${escapeHtml(data.meta.model)}</p>
<p><strong>${escapeHtml(data.meta.verdict)}</strong></p>
${note ? `<p class="muted">${escapeHtml(note)}</p>` : ""}

<div class="stats">
  <div class="stat"><b>${data.score.value}<span class="muted" style="font-size:1rem">/100</span></b>Score · grade ${escapeHtml(data.score.grade)}</div>
  <div class="stat"><b>${data.stats.endpointsExplored}</b>Endpoints explored</div>
  <div class="stat"><b>${data.stats.vulnerabilitiesFound}</b>Vulnerabilities</div>
</div>
<div class="row">${chips}</div>
${data.score.rationale ? `<p class="muted">${escapeHtml(data.score.rationale)}</p>` : ""}

<h2>Executive summary</h2>
<p>${escapeHtml(data.meta.summary)}</p>

${data.topTypes.length ? `<h2>Most common types</h2>${data.topTypes.map((t) => `<p><strong>${escapeHtml(t.type)}</strong> ×${t.count} — ${escapeHtml(t.description)}</p>`).join("")}` : ""}

<h2>Findings (${data.findings.length})</h2>
${findings || '<p class="muted">No findings were confirmed.</p>'}

${data.recommendations.length ? `<h2>Recommendations</h2><ul>${data.recommendations.map((r) => `<li><strong>${escapeHtml(r.priority)}:</strong> ${escapeHtml(r.action)}</li>`).join("")}</ul>` : ""}

<h2>Coverage</h2>
${data.coverage.tested.length ? `<p><strong>Tested</strong></p><ul>${data.coverage.tested.map((t) => `<li>${escapeHtml(t)}</li>`).join("")}</ul>` : ""}
${data.coverage.notCovered.length ? `<p><strong>Not covered</strong></p><ul>${data.coverage.notCovered.map((t) => `<li>${escapeHtml(t)}</li>`).join("")}</ul>` : ""}
</main></body></html>`;
}

/* ------------------------------------------------------------------ driver */

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n…[truncated]`;
}

/** A usable report from the deterministic data alone, if the model output is unusable. */
function fallbackReport(input: ReportInput, reason: string): ReportData {
  const scan = input.staticReport as
    | { summary?: { bySeverity?: Record<string, number> }; results?: Array<{ title: string; severity: number; vulnerable: boolean; request?: { url: string } }> }
    | null
    | undefined;

  const hits = (scan?.results ?? []).filter((result) => result.vulnerable);
  const findings: ReportFinding[] = hits.slice(0, 40).map((hit) => {
    const severity: Severity = hit.severity >= 9 ? "Critical" : hit.severity >= 7 ? "High" : hit.severity >= 4 ? "Medium" : "Low";
    return {
      id: slugify(hit.title),
      title: hit.title,
      severity,
      category: "Static rule",
      method: "GET",
      endpoint: hit.request?.url ?? "",
      impact: "",
      evidence: "",
      remediation: "",
      owasp: "",
      cwe: "",
      confidence: "Medium",
    };
  });

  const bySeverity = Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<Severity, number>;
  for (const finding of findings) bySeverity[finding.severity] += 1;

  const value = Math.max(0, 100 - bySeverity.Critical * 25 - bySeverity.High * 15 - bySeverity.Medium * 6 - bySeverity.Low * 2);

  return {
    meta: {
      target: input.target,
      title: "API Security Assessment",
      verdict: `${findings.length} rule violations detected by the static engine.`,
      summary: reason,
      generatedAt: new Date().toISOString(),
      model: "static-engine",
    },
    score: { value, grade: gradeFor(value), rationale: "Derived from static rule severities only." },
    stats: { endpointsExplored: 0, vulnerabilitiesFound: findings.length, bySeverity },
    distribution: SEVERITIES.map((severity) => ({ severity, count: bySeverity[severity] })),
    topTypes: [],
    findings,
    coverage: { tested: [], notCovered: ["The narrative report could not be generated, so only static results are shown."] },
    recommendations: [],
  };
}

/** Shown on the always-present copy so it is obvious it needs no model call. */
const STATIC_NOTE =
  "Static export — written on every generation and readable with no backend running. Kept at /final-report.html as a fallback when the model is unavailable.";

/** The static copy kept at `/final-report.html`. */
export function renderFinalReportHtml(data: ReportData): string {
  return renderReportHtml(data, STATIC_NOTE);
}

/** Writes the saved data, the dashboard export and the always-on static copy. */
async function writeReportFiles(data: ReportData): Promise<void> {
  await mkdir(dirname(REPORT_JSON), { recursive: true });
  await mkdir(dirname(REPORT_PATH), { recursive: true });
  await mkdir(dirname(FINAL_REPORT_PATH), { recursive: true });
  await writeFile(REPORT_JSON, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await writeFile(REPORT_PATH, renderReportHtml(data), "utf8");
  await writeFile(FINAL_REPORT_PATH, renderFinalReportHtml(data), "utf8");
}

/** The model-filled report. Throws when the provider is unreachable or answers unusably. */
async function narrativeReport(input: ReportInput): Promise<ReportData> {
  const { models, model } = createDeepSeek();
  const modelId = String((model as { id?: string }).id ?? "unknown");

  const findings = await readFile(input.findingsPath ?? "findings.md", "utf8").catch(
    () => "(no findings.md — the agent has not run yet)",
  );

  const staticText = input.staticReport
    ? JSON.stringify(input.staticReport)
    : "(the static rules have not been run yet)";

  const completion = await models.completeSimple(model, {
    systemPrompt: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content:
          `Target: ${input.target}\n\n` +
          `## Confirmed findings (findings.md)\n\n${truncate(findings, MAX_INPUT_CHARS)}\n\n` +
          `## Static rule results (JSON)\n\n${truncate(staticText, MAX_INPUT_CHARS)}\n\n` +
          `Return the JSON object now.`,
        timestamp: Date.now(),
      },
    ],
  });

  const reply = completion.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("");

  return normalize(extractJson(reply) as Record<string, unknown>, input.target, modelId);
}

export async function generateReportData(input: ReportInput): Promise<ReportData> {
  let data: ReportData;
  try {
    data = await narrativeReport(input);
  } catch (error) {
    // A dead key, an unreachable provider or a rambling model must not leave the dashboard
    // empty — the deterministic data is already a usable report, so export that instead.
    data = fallbackReport(
      input,
      `The narrative report could not be generated (${error instanceof Error ? error.message : String(error)}). Falling back to the static results.`,
    );
  }

  await writeReportFiles(data);
  return data;
}

/** The last generated report, so a refresh can re-render without another model call. */
export async function readReportData(): Promise<ReportData | null> {
  const raw = await readFile(REPORT_JSON, "utf8").catch(() => null);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ReportData;
  } catch {
    return null;
  }
}

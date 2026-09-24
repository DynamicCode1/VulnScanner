/**
 * Turns a finished assessment into a standalone `report.html`.
 *
 * Two inputs go to the model: `findings.md` (what the agent confirmed with evidence)
 * and the static rules report (what the deterministic engine found). The model writes
 * one self-contained HTML document — inline CSS, no external requests — so it opens
 * anywhere, including straight off disk.
 */

import { readFile, writeFile } from "node:fs/promises";
import { createDeepSeek } from "./agent";

export const REPORT_PATH = "report.html";

/** Enough to describe everything, bounded so the request stays cheap. */
const MAX_INPUT_CHARS = 30_000;

const SYSTEM_PROMPT = `You are a security engineer writing the final client-facing assessment report.

Output ONE complete, standalone HTML document and nothing else. Your reply must begin with the literal characters <!DOCTYPE html> — not a fragment, not a fence, no preamble, no explanation after.

Hard requirements:
- Inline all CSS in a single <style> block. No external stylesheets, fonts, images or scripts — the file must render with no network.
- Dark theme: background #0b0b0f, panels #14141b, text #e7e7ea, muted #9a9aa5. Red #f87171 for critical/high, amber #fbbf24 for medium, blue #60a5fa for low. Monospace for evidence.
- Start with a header block: target origin, generation timestamp, and a one-line verdict.
- Then an executive summary of 3-6 sentences a non-engineer can act on.
- Then a row of severity counts for Critical / High / Medium / Low.
- Then one card per confirmed finding: title, severity pill, affected endpoint, the evidence in a <pre> block, and the remediation. Preserve the evidence text exactly — do not paraphrase or truncate it.
- Then a table of the static rule results that actually hit, with rule name, severity, and status.
- Then a short "what was not covered" section, honest about gaps (unfilled placeholder routes, checks that could not run).
- Use semantic HTML and heading levels. It must be readable on a narrow screen.

Do not invent findings. If a section has no data, say so plainly rather than padding it.`;

export interface ReportInput {
  target: string;
  findingsPath?: string;
  staticReport?: unknown;
}

export interface ReportResult {
  path: string;
  html: string;
  model: string;
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n…[truncated]`;
}

/** Models sometimes wrap output in fences, add a sentence, or omit the document wrapper. */
function extractHtml(reply: string): string {
  let text = reply.trim();

  // Strip a markdown fence if the model wrapped its output in one.
  const fenced = /^```(?:html)?\s*([\s\S]*?)\s*```$/.exec(text);
  if (fenced?.[1]) text = fenced[1].trim();

  const doctype = text.indexOf("<!DOCTYPE");
  const htmlTag = text.indexOf("<html");
  const from = doctype >= 0 ? doctype : htmlTag;
  if (from >= 0) return text.slice(from).trim();

  // No document wrapper — the model handed back the report body. Wrap it as HTML.
  // Escaping here turned a perfectly good report into a wall of visible markup.
  const looksLikeHtml = /<(?:h1|h2|h3|p|div|section|style|table|ul|ol|pre)\b/i.test(text);
  return shell(text, !looksLikeHtml);
}

function escapeHtml(value: string): string {
  return value.replace(/[<>&]/g, (char) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[char]!);
}

const SHELL_STYLE = `:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:#0b0b0f;color:#e7e7ea;font:16px/1.65 system-ui,-apple-system,'Segoe UI',sans-serif;padding:40px 24px}
main{max-width:880px;margin:0 auto}
h1{font-size:1.7rem;letter-spacing:-.02em;margin:0 0 1rem}
h2{font-size:1.15rem;margin:2rem 0 .6rem;padding-bottom:.35rem;border-bottom:1px solid #ffffff1a}
h3{font-size:1rem;margin:1.4rem 0 .4rem}
p{margin:.6rem 0}
pre{background:#14141b;border:1px solid #ffffff14;border-radius:10px;padding:14px;overflow:auto;font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;word-break:break-word}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.9em}
table{width:100%;border-collapse:collapse;font-size:.9rem;margin:.8rem 0}
th,td{border:1px solid #ffffff1a;padding:6px 10px;text-align:left}
th{background:#14141b}
a{color:#6ee7b7}
strong{color:#fff}`;

/** Last-ditch wrapper so the button always produces an openable file. */
function shell(body: string, escape: boolean): string {
  const content = escape ? `<main><pre>${escapeHtml(body)}</pre></main>` : `<main>${body}</main>`;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Assessment report</title>
<style>${SHELL_STYLE}</style></head>
<body>${content}</body></html>`;
}

export async function generateReport(input: ReportInput): Promise<ReportResult> {
  const { models, model } = createDeepSeek();

  const findings = await readFile(input.findingsPath ?? "findings.md", "utf8").catch(
    () => "(no findings.md — the agent has not run yet)",
  );

  const staticText = input.staticReport
    ? JSON.stringify(input.staticReport, null, 2)
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
          `Write the report.html document now.`,
        timestamp: Date.now(),
      },
    ],
  });

  const text = completion.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("");

  const html = extractHtml(text);
  await writeFile(REPORT_PATH, html, "utf8");

  return { path: REPORT_PATH, html, model: String((model as { id?: string }).id ?? "unknown") };
}

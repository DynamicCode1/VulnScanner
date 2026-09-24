/**
 * SentinelAPI backend — the tool's own API, deliberately separate from the target it scans.
 *
 *   bun run src/api.ts        ->  http://127.0.0.1:5000
 *
 * Routes
 *   POST /api/spec      parse an uploaded OpenAPI document -> title, origin, surface
 *   POST /api/scan      run the static rules, streaming each result        (SSE)
 *   POST /api/agent     start or continue an agent session                 (SSE)
 *   POST /api/report    turn findings.md + the scan into report.html
 *   GET  /api/history   every probe and every model call
 *   GET  /report.html   the generated report
 *
 * The two long-running routes stream over SSE so the UI can show tests completing one
 * by one and the agent's tokens as they arrive, rather than waiting on one big response.
 */

import { createAgentSession, scanPrompt } from "./agent";
import { createHistoryFetch, handleHistoryRequest } from "./history";
import { REPORT_PATH, generateReportData, readReportData } from "./report";
import { loadChecks, runStaticChecks } from "./staticChecker";
import { inspectSpec, resolveApi } from "./swagger";

const port = Number(process.env.PORT ?? 5000);
const DEFAULT_RULES = process.env.RULES_FILE ?? "src/static_checker.json";

/** The most recent static scan per origin — the report generator reads it back. */
const lastScans = new Map<string, unknown>();

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  return (await request.json().catch(() => ({}))) as Record<string, unknown>;
}

/** Server-sent events: one JSON object per `data:` line, plus a keepalive comment. */
function sse(run: (send: (event: unknown) => void) => Promise<void>): Response {
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: unknown) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          // The client went away; nothing useful to do about it.
        }
      };

      // Model calls can sit silent for a while. An empty comment keeps proxies and
      // the browser from treating the stream as dead.
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          /* closed */
        }
      }, 15_000);

      try {
        await run(send);
      } catch (error) {
        send({ type: "error", message: error instanceof Error ? error.message : String(error) });
      } finally {
        clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}

/* ------------------------------------------------------------------ routes */

async function handleSpec(request: Request): Promise<Response> {
  const body = await readBody(request);
  const raw = body.spec;

  try {
    // No document supplied: describe the default surface a URL-only scan assumes.
    if (raw === undefined) {
      const api = await resolveApi({});
      return json({
        title: api.title,
        version: api.version,
        baseUrl: api.baseUrl,
        endpoints: api.endpoints,
        source: api.source,
      });
    }

    const text = typeof raw === "string" ? raw : JSON.stringify(raw);
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") throw new Error("That file is not an OpenAPI document.");
    const api = inspectSpec(parsed as never);
    return json({
      title: api.title,
      version: api.version,
      baseUrl: api.baseUrl,
      endpoints: api.endpoints,
      source: api.source,
    });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 400);
  }
}

async function handleScan(request: Request): Promise<Response> {
  const body = await readBody(request);
  const target = String(body.target ?? "").trim();
  if (!target) return json({ error: "A target origin is required." }, 400);

  const rules = String(body.rules ?? DEFAULT_RULES);
  let checks;
  try {
    checks = await loadChecks(rules);
  } catch (error) {
    return json({ error: `Could not load rules: ${(error as Error).message}` }, 400);
  }

  const concurrency = Math.min(Math.max(Number(body.concurrency ?? 8) || 8, 1), 24);

  return sse(async (send) => {
    // Send the full roster up front so the UI can render every test as "queued".
    send({
      type: "start",
      target,
      rules,
      total: checks.length,
      checks: checks.map((check, index) => ({
        index,
        title: check.title,
        description: check.description,
        severity: check.severity,
      })),
    });

    const report = await runStaticChecks(checks, target, {
      concurrency,
      // Route probes through the history wrapper so static and agent traffic land in
      // the same Burp-style log.
      fetchImpl: createHistoryFetch(),
      onCheckStart: (check, index) => send({ type: "running", index, title: check.title }),
      onCheckResult: (result, index) => send({ type: "result", index, result }),
    });

    lastScans.set(report.target.baseUrl ?? target, report);
    send({ type: "done", target: report.target, summary: report.summary, durationMs: report.durationMs });
  });
}

async function handleAgent(request: Request): Promise<Response> {
  const body = await readBody(request);
  const sessionId = body.sessionId ? String(body.sessionId) : undefined;
  const message = body.message ? String(body.message) : undefined;
  const target = body.target ? String(body.target) : undefined;

  return sse(async (send) => {
    const session = await createAgentSession({
      resume: sessionId,
      target,
      onEvent: (line) => send({ type: "log", line }),
      onDelta: (text) => send({ type: "delta", text }),
    });

    send({ type: "session", sessionId: session.sessionId, target: session.target, restored: session.restored });

    await session.agent.prompt(message ?? scanPrompt(session.target));
    await session.agent.waitForIdle();

    send({
      type: "done",
      sessionId: session.sessionId,
      findings: session.state.findings,
      turns: session.state.turns,
      stopped: session.state.stopped,
      messages: session.agent.state.messages.length,
      error: session.agent.state.errorMessage,
    });

    session.agent.reset();
  });
}

async function handleReport(request: Request): Promise<Response> {
  // GET returns the last report so a refresh can re-render without another model call.
  if (request.method === "GET") {
    const data = await readReportData();
    return data ? json(data) : json({ error: "No report generated yet." }, 404);
  }

  const body = await readBody(request);
  const target = String(body.target ?? "").trim();

  return sse(async (send) => {
    send({ type: "status", text: "Reading findings.md and the static scan…" });
    send({ type: "status", text: "Filling the report schema…" });

    const data = await generateReportData({
      target,
      findingsPath: String(body.findingsPath ?? process.env.FINDINGS_PATH ?? "findings.md"),
      staticReport: lastScans.get(target) ?? null,
    });

    send({ type: "done", data });
  });
}

/* ------------------------------------------------------------------ server */

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  // SSE streams go quiet during a model call; the default 10s idle timeout would cut them.
  idleTimeout: 240,
  async fetch(request) {
    const { pathname } = new URL(request.url);

    if (pathname === "/api/spec" && request.method === "POST") return handleSpec(request);
    if (pathname === "/api/scan" && request.method === "POST") return handleScan(request);
    if (pathname === "/api/agent" && request.method === "POST") return handleAgent(request);
    if (pathname === "/api/report") return handleReport(request);

    if (pathname === "/report.html" && request.method === "GET") {
      const file = Bun.file(REPORT_PATH);
      if (!(await file.exists())) return json({ error: "No report generated yet." }, 404);
      return new Response(file, { headers: { "content-type": "text/html; charset=utf-8" } });
    }

    const history = await handleHistoryRequest(request);
    if (history) return history;

    return json({ error: `No route for ${request.method} ${pathname}` }, 404);
  },
});

console.log(`SentinelAPI backend listening on http://127.0.0.1:${server.port}\n`);
console.log(`  POST   /api/spec                parse an uploaded spec`);
console.log(`  POST   /api/scan                static rules, streamed (SSE)`);
console.log(`  POST   /api/agent               agent run / chat (SSE)`);
console.log(`  POST   /api/report              generate report.html`);
console.log(`  GET    /api/history             every probe and model call`);
console.log(`  GET    /report.html             the generated report`);

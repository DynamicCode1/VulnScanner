/**
 * SentinelAPI agent loop — an LLM-driven pentester built on @earendil-works/pi-agent-core.
 *
 *   bun run src/agent.ts                      # target from TARGET_URL in .env
 *   bun run src/agent.ts http://host:1234     # explicit target
 *
 * The agent gets three tools: `run_curl` (real curl, no shell), `record_finding`
 * (appends to findings.md, creating it if needed) and `finish_scan`.
 *
 * Stopping is belt-and-braces, because pi-agent-core only honours `terminate: true`
 * when *every* tool result in the batch sets it — so a model that batches
 * `run_curl` + `finish_scan` together would otherwise loop forever:
 *   1. `finish_scan` returns `terminate: true`  (the documented mechanism)
 *   2. `finishTurn` also inspects the turn and ends the run if the tool fired,
 *      if the assistant replied with a bare STOP, or if the turn budget is spent.
 *
 * Safety: this executes real shell commands, so the blast radius is pinned down.
 * - no shell is involved — the curl string is tokenised and handed to spawn as argv
 * - the command must start with `curl`
 * - flags that read or write local files (-o/-T/-K/-c/…) are rejected
 * - the request URL must sit on the target origin
 *
 * Known residual gap: `-L` is allowed, because checking redirects is legitimate, but
 * that means a redirect can carry the request off-origin. Tighten this if the agent is
 * ever pointed at something other than a lab you control.
 */

import { Agent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import { createModels, type MutableModels, type Model, type StreamFunction } from "@earendil-works/pi-ai";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { Type } from "typebox";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { parseCurl, tokenizeCurl } from "./staticChecker";
import { recordHistory, recordLlmExchange, type LlmHistoryRequest } from "./history";
import {
  appendMessage,
  createSession,
  listSessions,
  loadSession,
  newSessionId,
  resolveSessionId,
} from "./session";

/* ------------------------------------------------------------------ config */

const DEFAULT_TARGET = "http://127.0.0.1:5001";
/** "Use `deepseek-flash` as the model name" — DeepSeek's V4.1 Flash, the current default tier. */
const DEFAULT_MODEL = "deepseek-flash";
const DEFAULT_MAX_TURNS = 20;
const MAX_CURL_OUTPUT = 6_000;
/** How many recent messages the model is shown. The transcript itself is never trimmed. */
const DEFAULT_CONTEXT_MESSAGES = 20;
/** Ceiling on the findings.md block that rides along with every request. */
const MAX_FINDINGS_CHARS = 4_000;

/**
 * DeepSeek still accepts these retired names and serves them from DeepSeek-V4.1-Flash,
 * so resolve them rather than failing the lookup.
 */
const MODEL_ALIASES: Record<string, string> = {
  "deepseek-v4-flash": "deepseek-flash",
  "deepseek-v4-flash-vision-exp": "deepseek-flash",
};

/* ------------------------------------------------------------------ safety */

/** Flags that can read a local file, write a local file, or both. */
const FILE_FLAGS = new Set([
  "-o", "--output", "-O", "--remote-name", "--output-dir",
  "-T", "--upload-file", "-K", "--config", "-c", "--cookie-jar",
  "--netrc", "--netrc-file", "--libcurl", "--trace", "--trace-ascii",
  "-w", "--write-out", "-D", "--dump-header", "--hsts", "--alt-svc",
]);

/** …except when they are pointed at stdout or the bit bucket, which is how curls are normally written. */
const HARMLESS_TARGETS = new Set(["-", "/dev/null"]);
const FILE_FLAGS_WITH_HARMLESS_TARGET = new Set(["-o", "--output", "-D", "--dump-header", "--hsts", "--alt-svc"]);

export function assertSafeCurl(tokens: string[]): void {
  for (const token of tokens) {
    if (token.startsWith("@")) {
      throw new Error("curl @file arguments are not allowed — they read local files.");
    }
  }

  for (let i = 1; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    const equals = token.startsWith("--") ? token.indexOf("=") : -1;
    const flag = equals === -1 ? token : token.slice(0, equals);
    if (!FILE_FLAGS.has(flag)) continue;

    if (FILE_FLAGS_WITH_HARMLESS_TARGET.has(flag)) {
      const value = equals === -1 ? tokens[i + 1] : token.slice(equals + 1);
      if (value !== undefined && HARMLESS_TARGETS.has(value)) continue;
    }

    throw new Error(`curl flag ${flag} is not allowed — it can read or write files outside the scan.`);
  }
}

/* -------------------------------------------------------------- text utils */

function messageText(message: unknown): string {
  const content = (message as { content?: unknown })?.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: string; text: string } =>
      Boolean(part) && (part as { type?: string }).type === "text" && typeof (part as { text?: unknown }).text === "string")
    .map((part) => part.text)
    .join("")
    .trim();
}

function truncate(text: string, limit: number): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  return { text: `${text.slice(0, limit)}\n…[truncated ${text.length - limit} more characters]`, truncated: true };
}

/** Pulls the status line out of raw `curl -i` output, when curl printed one. */
function statusFromCurlOutput(output: string): { status: number; statusText: string } {
  const match = /^HTTP\/[\d.]+\s+(\d{3})[ \t]*(.*)$/m.exec(output);
  if (!match) return { status: 0, statusText: "" };
  return { status: Number(match[1]), statusText: (match[2] ?? "").trim() };
}

async function readFindings(findingsPath: string): Promise<string> {
  const text = (await readFile(findingsPath, "utf8").catch(() => "")).trim();
  if (!text) return "(nothing recorded yet)";
  return text.length > MAX_FINDINGS_CHARS
    ? `${text.slice(0, MAX_FINDINGS_CHARS)}\n…[findings truncated — see ${findingsPath}]`
    : text;
}

/**
 * Bounds what the model sees.
 *
 * This does NOT touch the transcript: sessions and the history log still keep every
 * message. It only decides the context for the next request — the leading system
 * message, the current findings.md, and the most recent `keep` messages. Without this
 * each call resends the whole conversation, so both the context and the log grow
 * with the square of the conversation length.
 */
function windowContext(
  messages: AgentMessage[],
  keep: number,
  findingsPath: string,
  findings: string,
  log: (line: string) => void,
): AgentMessage[] {
  // Preserve the leading system message: it carries the prompt and tool declarations.
  let head = 0;
  while (head < messages.length && (messages[head] as { role?: string }).role === "system") head += 1;

  const leading = messages.slice(0, head);
  const rest = messages.slice(head);
  let windowed = rest.length > keep ? rest.slice(rest.length - keep) : rest;

  // A toolResult whose assistant tool-call message fell outside the window is rejected
  // outright by the provider, so the window must never begin on one.
  let start = 0;
  while (start < windowed.length && (windowed[start] as { role?: string }).role === "toolResult") start += 1;
  windowed = windowed.slice(start);

  if (windowed.length < rest.length) {
    log(`    context: last ${windowed.length} of ${rest.length} messages + findings.md`);
  }

  // A system message rather than a user one: pi-ai sends it in place for providers that
  // support mid-conversation system messages, and folds it into the leading prompt for
  // those that don't — DeepSeek Flash is in the second group.
  const findingsMessage = {
    role: "system",
    content:
      `<confirmed_findings path="${findingsPath}">\n${findings}\n</confirmed_findings>\n\n` +
      "These are already recorded. Do not re-test them — build on them.",
    timestamp: Date.now(),
  } as unknown as AgentMessage;

  return [...leading, findingsMessage, ...windowed];
}

/* ------------------------------------------------------------------- state */

interface RunState {
  findings: number;
  turns: number;
  finished: boolean;
  stopped: "finished" | "stop-word" | "turn-limit" | "ended" | "error";
}

/* ------------------------------------------------------------------- tools */

export interface AgentRunOptions {
  target?: string;
  findingsPath?: string;
  maxTurns?: number;
  /** Injected by tests. Defaults to the DeepSeek model configured in .env. */
  model?: Model<never> | Model<any>;
  streamFn?: StreamFunction;
  /** Set to false to suppress the live trace. */
  onEvent?: (line: string) => void;
  /** Receives streamed assistant text. Defaults to stdout. */
  onDelta?: (chunk: string) => void;
  /** Session id — or "last" — to continue a saved conversation instead of starting one. */
  resume?: string;
  /** The user message. Defaults to the standard assessment prompt on a new session. */
  prompt?: string;
  /** How many recent messages reach the model. Default 20 (env `AGENT_CONTEXT_MESSAGES`). */
  maxContextMessages?: number;
}

function buildSystemPrompt(targetOrigin: string, findingsPath: string): string {
  return `You are an authorized API security tester working inside a sanctioned local lab. You are not attacking a stranger's service — this target is deliberately vulnerable and provided for testing.

Your job is to probe ${targetOrigin}, confirm real vulnerabilities with reproducible evidence, and record each one.

RULES OF ENGAGEMENT
- The only way you may touch the network is the run_curl tool, and every request must be aimed at ${targetOrigin}.
- Prefer GET and HEAD. Never send a request that changes or deletes data.
- Change one thing per request so you always know what caused the response.
- A finding is only real when you can show the exact request and the response bytes that prove it. Missing signals are NOT findings.
- Never invent endpoints, response bodies, or evidence. If you did not see it in a tool result, do not write it.

METHOD
1. Discover the surface first: fetch /openapi.json and /.
2. Work the high-value classes in roughly this order:
   - Broken object level authorization: can you read a record that belongs to someone else?
   - Excessive data exposure: do responses leak password hashes, SSNs, keys, internal notes?
   - Missing authentication on a privileged route: does an admin/config route answer without credentials?
   - Verbose errors: do failures leak SQL, stack traces or filesystem paths?
   - Transport and browser policy: permissive CORS, missing security headers, weak session cookies.
3. For each confirmed issue, call record_finding once, quoting the real evidence.
4. When you have genuinely finished, call finish_scan with a short summary.
   (Replying with the single word STOP also ends the run.)

MEMORY
Your conversation is trimmed as it grows: you see the most recent exchanges, plus a \`<confirmed_findings>\` block that is re-read from ${findingsPath} before every step. That block is your durable memory. If something matters later in the assessment, record it there rather than relying on remembering it — older turns will not be there.

Write findings to ${findingsPath}. Be concise and factual — this output is read by engineers.`;
}

function createTools(state: RunState, targetOrigin: string, findingsPath: string, log: (line: string) => void) {
  const CurlParams = Type.Object({
    command: Type.String({
      description: `Full curl command to execute, e.g. curl -i '${targetOrigin}/api/orders/1' -H 'Authorization: Bearer token-bob'`,
    }),
    reason: Type.String({ description: "One short line: the hypothesis this request tests." }),
  });

  const runCurl: AgentTool<typeof CurlParams> = {
    name: "run_curl",
    label: "Run curl",
    description:
      "Execute a curl command against the target and return its raw stdout/stderr. " +
      "Only curl is allowed, no shell operators, no local file access, and the URL must be on the target origin.",
    parameters: CurlParams,
    executionMode: "sequential",
    execute: async (_toolCallId, params, signal) => {
      const argv = tokenizeCurl(params.command);
      if (argv[0] !== "curl") {
        throw new Error(`Only curl commands are allowed. The command must start with "curl", got "${argv[0] ?? ""}".`);
      }
      assertSafeCurl(argv);

      const parsedRequest = parseCurl(params.command);
      const requested = parsedRequest.url;
      if (!requested) throw new Error("No URL found in the curl command.");
      let origin: string;
      try {
        origin = new URL(requested).origin;
      } catch {
        throw new Error(`The URL "${requested}" is not absolute. Use ${targetOrigin}.`);
      }
      if (origin !== targetOrigin) {
        throw new Error(`Refusing to send a request to ${origin} — this run is scoped to ${targetOrigin}.`);
      }

      const started = performance.now();
      const process_ = Bun.spawn(argv, {
        stdout: "pipe",
        stderr: "pipe",
        ...(signal ? { signal } : {}),
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(process_.stdout).text(),
        new Response(process_.stderr).text(),
        process_.exited,
      ]);
      const durationMs = Math.round(performance.now() - started);

      const combined = [stdout, stderr].filter(Boolean).join("\n");
      const { text, truncated } = truncate(combined.trim() || "(no output)", MAX_CURL_OUTPUT);

      log(`    curl ${requested} -> exit ${exitCode} in ${durationMs}ms${truncated ? " (truncated)" : ""}`);

      // Record the probe itself. Without this the history would hold model calls only,
      // and the requests those calls triggered — the interesting half — would be missing.
      const status = statusFromCurlOutput(combined);
      await recordHistory(
        {
          method: parsedRequest.method,
          url: requested,
          headers: parsedRequest.headers,
          ...(parsedRequest.body ? { body: parsedRequest.body } : {}),
        },
        {
          status: status.status,
          statusText: status.statusText,
          // curl prints headers inline when -i/-D is used; the raw output is the body here.
          headers: {},
          body: text,
          bodyBytes: new TextEncoder().encode(combined).length,
          durationMs,
        },
        // curl sometimes reports a write error (exit 23) *after* the response was already
        // captured. That is not a failed probe, so only flag it when nothing came back.
        exitCode !== 0 && status.status === 0 ? { error: `curl exited with code ${exitCode}` } : {},
      );

      return {
        content: [{ type: "text", text }],
        details: { command: params.command, url: requested, exitCode, durationMs, truncated },
      };
    },
  };

  const FindingParams = Type.Object({
    title: Type.String({ description: "Short name, e.g. 'BOLA: any caller can read any order'." }),
    severity: Type.Union([
      Type.Literal("Critical"),
      Type.Literal("High"),
      Type.Literal("Medium"),
      Type.Literal("Low"),
      Type.Literal("Info"),
    ]),
    endpoint: Type.String({ description: "Method and path, e.g. GET /api/orders/1" }),
    evidence: Type.String({ description: "The exact request sent and the response bytes that prove it." }),
    remediation: Type.String({ description: "The concrete fix." }),
  });

  const recordFinding: AgentTool<typeof FindingParams> = {
    name: "record_finding",
    label: "Record finding",
    description: `Append one confirmed vulnerability to ${findingsPath}. Only call this for issues you have actually proven with a response.`,
    parameters: FindingParams,
    executionMode: "sequential",
    execute: async (_toolCallId, params) => {
      state.findings += 1;
      const entry = [
        "",
        `## ${state.findings}. ${params.title} — ${params.severity}`,
        "",
        `- **Endpoint:** \`${params.endpoint}\``,
        `- **Severity:** ${params.severity}`,
        `- **Recorded:** ${new Date().toISOString()}`,
        "",
        "**Evidence**",
        "",
        "```",
        params.evidence.trim(),
        "```",
        "",
        "**Remediation**",
        "",
        params.remediation.trim(),
        "",
      ].join("\n");

      await appendFile(findingsPath, entry, "utf8");
      log(`    recorded #${state.findings}: ${params.title} [${params.severity}]`);

      return {
        content: [{ type: "text", text: `Recorded finding #${state.findings} in ${findingsPath}.` }],
        details: { title: params.title, severity: params.severity, endpoint: params.endpoint },
      };
    },
  };

  const FinishParams = Type.Object({
    summary: Type.String({ description: "Two or three sentences on what was tested and what was found." }),
  });

  const finishScan: AgentTool<typeof FinishParams> = {
    name: "finish_scan",
    label: "Finish scan",
    description: "Call once the assessment is genuinely complete. This ends the run immediately.",
    parameters: FinishParams,
    execute: async (_toolCallId, params) => {
      state.finished = true;
      state.stopped = "finished";
      log(`    finish_scan: ${params.summary}`);
      return {
        content: [{ type: "text", text: `Assessment complete. ${params.summary}` }],
        details: { summary: params.summary },
        terminate: true,
      };
    },
  };

  return [runCurl, recordFinding, finishScan];
}

/* ------------------------------------------------------------------ runner */

export interface AgentRunResult {
  sessionId: string;
  target: string;
  findingsPath: string;
  findings: number;
  turns: number;
  stopped: RunState["stopped"];
  transcript: number;
  /** Provider/transport failure, e.g. a rejected API key. */
  error?: string;
}

/** Builds the DeepSeek client from the environment. Shared with the report generator. */
export function createDeepSeek(): {
  models: MutableModels;
  model: Model<any>;
  streamFn: StreamFunction;
} {
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "DEEPSEEK_API_KEY is not set.\n" +
        "  1. cp .env.example .env\n" +
        "  2. put your key from https://platform.deepseek.com/api_keys in .env\n" +
        "  (.env is gitignored; Bun loads it automatically.)",
    );
  }

  const models = createModels();
  models.setProvider(deepseekProvider());

  const id = process.env.DEEPSEEK_MODEL?.trim() || DEFAULT_MODEL;
  const resolvedId = MODEL_ALIASES[id] ?? id;
  const model = models.getModel("deepseek", resolvedId);
  if (!model) {
    const known = models.getModels("deepseek").map((entry) => `${entry.id} (${entry.name})`).join(", ");
    throw new Error(`Unknown DEEPSEEK_MODEL "${id}". Available: ${known}`);
  }

  return { models, model, streamFn: models.streamSimple.bind(models) as unknown as StreamFunction };
}

/** A live conversation: the agent, plus the session file it is being recorded into. */
export interface AgentSession {
  sessionId: string;
  target: string;
  findingsPath: string;
  agent: Agent;
  state: RunState;
  /** Messages restored from disk — 0 for a fresh conversation. */
  restored: number;
}

/** Keeps finding numbering going across resumed conversations. */
function countFindings(markdown: string): number {
  return (markdown.match(/^## \d+\./gm) ?? []).length;
}

export function scanPrompt(origin: string): string {
  return (
    `Assess ${origin} for API vulnerabilities. ` +
    `Discover the surface, test the highest-value classes first, ` +
    `record only findings you have proven with a real response, then call finish_scan.`
  );
}

/**
 * Opens a conversation, resuming a saved one or starting a fresh one.
 *
 * On resume, the target and findings path come from the saved header rather than from
 * the environment — so continuing yesterday's chat cannot silently re-aim it at a
 * different host.
 */
export async function createAgentSession(options: AgentRunOptions = {}): Promise<AgentSession> {
  const log = options.onEvent ?? ((line: string) => console.log(line));
  const write = options.onDelta ?? ((chunk: string) => process.stdout.write(chunk));
  const maxTurns = options.maxTurns ?? Number(process.env.AGENT_MAX_TURNS ?? DEFAULT_MAX_TURNS);
  const maxContextMessages =
    options.maxContextMessages ?? Number(process.env.AGENT_CONTEXT_MESSAGES ?? DEFAULT_CONTEXT_MESSAGES);

  let model = options.model;
  let streamFn = options.streamFn;
  if (!model || !streamFn) {
    const deepseek = createDeepSeek();
    model ??= deepseek.model;
    streamFn ??= deepseek.streamFn;
  }

  let sessionId: string;
  let targetOrigin: string;
  let findingsPath: string;
  let messages: unknown[] = [];
  let restored = 0;

  if (options.resume) {
    sessionId = await resolveSessionId(options.resume);
    const saved = await loadSession(sessionId);
    targetOrigin = saved.header.target;
    findingsPath = options.findingsPath ?? saved.header.findingsPath;
    messages = saved.messages;
    restored = messages.length;
  } else {
    const target = (options.target ?? process.env.TARGET_URL ?? DEFAULT_TARGET).replace(/\/+$/, "");
    targetOrigin = new URL(target).origin;
    findingsPath = options.findingsPath ?? process.env.FINDINGS_PATH ?? "findings.md";
    sessionId = newSessionId();
    await createSession({
      id: sessionId,
      createdAt: new Date().toISOString(),
      target: targetOrigin,
      model: String((model as { id?: string }).id ?? "unknown"),
      findingsPath,
    });
  }

  // Create findings.md up front so the file exists even before the first hit.
  const existing = await readFile(findingsPath, "utf8").catch(() => null);
  if (existing === null) {
    await writeFile(
      findingsPath,
      `# Findings — ${targetOrigin}\n\n_Generated by the SentinelAPI agent on ${new Date().toISOString()}._\n`,
      "utf8",
    );
  }

  const state: RunState = {
    findings: existing === null ? 0 : countFindings(existing),
    turns: 0,
    finished: false,
    stopped: "ended",
  };
  const tools = createTools(state, targetOrigin, findingsPath, log);

  /**
   * Model-call history.
   *
   * `prepareRequest` fires immediately before every provider request and hands over the
   * exact transcript being sent; the assistant's `message_end` is the reply to it. Pairing
   * those two is more faithful than wrapping the stream function, and doesn't risk
   * breaking streaming or `result()` for the caller.
   */
  let pendingCall: { startedAt: number; request: LlmHistoryRequest } | null = null;

  const agent = new Agent({
    initialState: {
      systemPrompt: buildSystemPrompt(targetOrigin, findingsPath),
      model: model as Model<any>,
      tools,
      // Restoring the transcript is what makes this a continuation rather than a fresh
      // conversation. pi-agent-core keeps a transcript's own leading system message, so
      // the saved prompt wins over the one above.
      ...(messages.length ? { messages: messages as never[] } : {}),
    },
    streamFn: streamFn as never,
    toolExecution: "sequential",

    prepareRequest: async ({ context, model: requestModel }) => {
      const ctx = context as { messages?: unknown[]; tools?: unknown[] };
      const raw = (ctx.messages ?? []) as AgentMessage[];

      // prepareRequest runs *before* transformContext, so the same window has to be
      // applied here too — otherwise the log stores the whole transcript on every call
      // and grows with the square of the conversation length, which is the whole thing
      // the window exists to prevent.
      let sent = raw;
      try {
        sent = windowContext(raw, maxContextMessages, findingsPath, await readFindings(findingsPath), () => {});
      } catch (error) {
        log(`    !! context window failed: ${error instanceof Error ? error.message : String(error)}`);
      }

      pendingCall = {
        startedAt: performance.now(),
        request: {
          provider: String((requestModel as { provider?: string }).provider ?? "unknown"),
          model: String((requestModel as { id?: string }).id ?? "unknown"),
          messages: sent,
          toolCount: ctx.tools?.length ?? 0,
        },
      };
      return undefined;
    },

    transformContext: async (messages) => {
      // Documented contract: must never throw or reject — fall back to the raw context.
      try {
        return windowContext(messages, maxContextMessages, findingsPath, await readFindings(findingsPath), log);
      } catch (error) {
        log(`    !! context window failed: ${error instanceof Error ? error.message : String(error)}`);
        return messages;
      }
    },

    // Backstop for the documented `terminate: true` mechanism: pi-agent-core only stops
    // early when EVERY result in the batch terminates, so a batched finish_scan would
    // not stop the loop on its own.
    finishTurn: async ({ message }) => {
      const stopReason = (message as { stopReason?: string }).stopReason;
      if (stopReason === "error" || stopReason === "aborted") {
        state.stopped = "error";
        return;
      }
      if (state.finished) return { action: "end" };

      if (/^stop[.!]?$/i.test(messageText(message))) {
        state.stopped = "stop-word";
        log("    assistant said STOP — ending run");
        return { action: "end" };
      }

      state.turns += 1;
      if (state.turns >= maxTurns) {
        state.stopped = "turn-limit";
        log(`    turn budget of ${maxTurns} reached — ending run`);
        return { action: "end" };
      }
      return;
    },
  });

  let streaming = false;
  const initial = agent.state.messages[0] as { role?: string } | undefined;
  if (!restored && initial?.role === "system") {
    // The system prompt arrives via initialState, not as a message event, so the
    // subscriber below never sees it. Record it explicitly — otherwise a resumed
    // conversation silently loses the prompt it was actually run under.
    await appendMessage(sessionId, initial);
  }

  agent.subscribe(async (event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      if (!streaming) {
        write("\n");
        streaming = true;
      }
      write(event.assistantMessageEvent.delta);
      return;
    }
    if (event.type === "tool_execution_start") {
      if (streaming) {
        write("\n");
        streaming = false;
      }
      log(`  ${event.toolName}(${JSON.stringify(event.args)})`);
      return;
    }
    if (event.type === "message_end") {
      if (streaming) {
        write("\n");
        streaming = false;
      }
      // Persist each message as it completes: the transcript survives a crash mid-run,
      // and a resumed conversation sees exactly what happened, tool results included.
      await appendMessage(sessionId, event.message);

      const message = event.message as {
        role?: string;
        content?: unknown[];
        stopReason?: string;
        usage?: unknown;
        errorMessage?: string;
      };

      // The reply to the request captured in prepareRequest — log the whole call.
      if (message.role === "assistant" && pendingCall) {
        const call = pendingCall;
        pendingCall = null;
        await recordLlmExchange({
          sessionId,
          request: call.request,
          response: {
            content: message.content ?? [],
            stopReason: message.stopReason,
            usage: message.usage,
            durationMs: Math.round(performance.now() - call.startedAt),
          },
          ...(message.stopReason === "error" && message.errorMessage ? { error: message.errorMessage } : {}),
        });
      }
    }
  });

  log(`\nTarget   ${targetOrigin}`);
  log(`Findings ${findingsPath}`);
  log(`Model    ${String((model as { id?: string }).id ?? "unknown")}`);
  log(`Session  ${sessionId}${restored ? ` — resumed, ${restored} messages restored` : ""}`);
  log(`Context  last ${maxContextMessages} messages + findings.md`);
  log(`Budget   ${maxTurns} turns\n`);

  return { sessionId, target: targetOrigin, findingsPath, agent, state, restored };
}

function summarize(session: AgentSession): AgentRunResult {
  const error = session.agent.state.errorMessage;
  return {
    sessionId: session.sessionId,
    target: session.target,
    findingsPath: session.findingsPath,
    findings: session.state.findings,
    turns: session.state.turns,
    stopped: session.state.stopped,
    transcript: session.agent.state.messages.length,
    ...(error ? { error } : {}),
  };
}

/** Runs one assessment. Model and streamFn can be injected, which is how the self-test runs offline. */
export async function runAgent(options: AgentRunOptions = {}): Promise<AgentRunResult> {
  const session = await createAgentSession(options);

  const prompt = options.prompt ?? (options.resume ? undefined : scanPrompt(session.target));
  if (!prompt) {
    throw new Error(
      `Session ${session.sessionId} is resumed but no message was given.\n` +
        `  Ask something:  bun run src/agent.ts --resume ${session.sessionId} "why is the order route the worst one?"\n` +
        `  Or chat:        bun run src/agent.ts --resume ${session.sessionId}`,
    );
  }

  await session.agent.prompt(prompt);
  await session.agent.waitForIdle();

  const result = summarize(session);
  session.agent.reset();
  return result;
}

/** Interactive continuation of a saved conversation. */
export async function chatSession(options: AgentRunOptions = {}): Promise<void> {
  const session = await createAgentSession({ ...options, resume: options.resume ?? "last" });
  console.log(`  Ask about the assessment, request more testing, or extend it. "exit" to stop.\n`);

  for await (const line of console) {
    const message = line.trim();
    if (!message) continue;
    if (message === "exit" || message === "quit") break;
    await session.agent.prompt(message);
    await session.agent.waitForIdle();
    console.log("");
  }

  session.agent.reset();
}

/* --------------------------------------------------------------------- CLI */

function report(result: AgentRunResult): void {
  console.log(`\n${"─".repeat(64)}`);
  console.log(`Stopped    ${result.stopped}`);
  if (result.error) console.log(`Error      ${result.error}`);
  console.log(`Turns      ${result.turns}`);
  console.log(`Messages   ${result.transcript}`);
  console.log(`Findings   ${result.findings} -> ${result.findingsPath}`);
  console.log(`Session    ${result.sessionId}`);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flags = new Map<string, string>();
  const positional: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--help" || arg === "-h") flags.set("help", "true");
    else if (arg === "--sessions") flags.set("sessions", "true");
    else if (arg.startsWith("--")) {
      i += 1;
      flags.set(arg.slice(2), args[i] ?? "");
    } else positional.push(arg);
  }

  const fail = (error: unknown): never => {
    console.error(`\n${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  };

  if (flags.get("help") === "true") {
    console.log(`usage:
  bun run src/agent.ts                        scan TARGET_URL from .env
  bun run src/agent.ts http://host:1234       scan a specific target
  bun run src/agent.ts --sessions             list saved conversations
  bun run src/agent.ts --resume last          continue the newest one, interactively
  bun run src/agent.ts --resume <id> "why?"   ask one follow-up question

Every run is saved under data/sessions/, so an assessment can be revisited,
questioned or extended long after it finished.`);
    process.exit(0);
  }

  if (flags.get("sessions") === "true") {
    const sessions = await listSessions();
    if (sessions.length === 0) {
      console.log("No saved conversations yet — run a scan first.");
    } else {
      console.log(`\n${"id".padEnd(10)}${"updated".padEnd(26)}${"msgs".padStart(5)}  target`);
      for (const session of sessions) {
        console.log(
          `${session.id.padEnd(10)}${session.updatedAt.padEnd(26)}${String(session.messageCount).padStart(5)}  ${session.target}`,
        );
      }
      console.log(`\nContinue one:  bun run src/agent.ts --resume <id>`);
    }
    process.exit(0);
  }

  const resumeFlag = flags.get("resume");
  if (resumeFlag !== undefined) {
    const resume = resumeFlag.trim() || "last";
    const message = positional.join(" ").trim();

    if (!message) {
      await chatSession({ resume }).catch(fail);
      process.exit(0);
    }

    const result = await runAgent({ resume, prompt: message }).catch(fail);
    report(result);
    process.exit(result.stopped === "error" ? 1 : 0);
  }

  const result = await runAgent({ target: positional[0] }).catch(fail);
  report(result);
  process.exit(result.stopped === "error" ? 1 : 0);
}

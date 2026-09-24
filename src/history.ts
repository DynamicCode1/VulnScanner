/**
 * Activity history — an append-only log of everything the tool did, in the order it
 * happened. Two kinds of exchange live here:
 *
 *   kind: "http"  one probe we sent, and the response we got back
 *   kind: "llm"   one model call, with the transcript we sent and what came back
 *
 * Storage is JSONL (`data/history.jsonl`): one exchange per line. Appends are cheap,
 * a crashed write can only ever lose the last line, and `tail -f` works during a demo.
 *
 * Two ways in, both automatic:
 *   - `createHistoryFetch()` wraps fetch, so every probe the checker or the agent makes
 *     is recorded without anyone remembering to call anything.
 *   - `recordLlmExchange()` is driven by the agent loop's `prepareRequest`/`message_end`
 *     hooks, so every model call is recorded the same way.
 *
 * Served by `handleHistoryRequest` at `/api/history` (`?kind=http|llm` to filter).
 */

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

/* ------------------------------------------------------------------ types */

export interface HistoryRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export interface HistoryResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  /** Full size of the body; `body` is capped, so these diverge on large responses. */
  bodyBytes: number;
  durationMs: number;
}

export interface HttpHistoryEntry {
  kind: "http";
  id: string;
  ts: string;
  request: HistoryRequest;
  /** null when the request never got a response (DNS failure, refused connection, timeout). */
  response: HistoryResponse | null;
  /** Present only for exchanges that failed before a response arrived. */
  error?: string;
}

export interface LlmHistoryRequest {
  provider: string;
  model: string;
  /** The transcript as sent. This is the real prompt context, so it grows with the conversation. */
  messages: unknown[];
  /** How many tools were declared to the model. */
  toolCount: number;
}

export interface LlmHistoryResponse {
  /** Assistant content blocks: text, thinking and tool calls. */
  content: unknown[];
  stopReason?: string;
  usage?: unknown;
  durationMs: number;
}

export interface LlmHistoryEntry {
  kind: "llm";
  id: string;
  ts: string;
  /** The agent conversation this call belongs to, when there is one. */
  sessionId?: string;
  request: LlmHistoryRequest;
  response: LlmHistoryResponse | null;
  error?: string;
}

export type HistoryEntry = HttpHistoryEntry | LlmHistoryEntry;
export type HistoryKind = HistoryEntry["kind"];

export interface HistoryOptions {
  /** Defaults to `$HISTORY_FILE` or `data/history.jsonl`. */
  file?: string;
  /** Max characters of body kept per exchange. Default 100_000. */
  maxBodyChars?: number;
}

export interface HistoryReadOptions extends HistoryOptions {
  /** Keep only the N most recent entries. 0 (default) means all of them. */
  limit?: number;
  /** "asc" = oldest first (default, chronological). "desc" = newest first. */
  order?: "asc" | "desc";
  /** Return only this kind of exchange. */
  kind?: HistoryKind;
}

export interface HistoryFetchOptions extends HistoryOptions {
  /** The fetch to wrap. Defaults to the global one. */
  delegate?: typeof fetch;
  /** Return false to skip recording (e.g. to keep the scanner out of its own log). */
  shouldRecord?: (url: string) => boolean;
}

/* -------------------------------------------------------------- internals */

const DEFAULT_HISTORY_FILE = "data/history.jsonl";
const DEFAULT_MAX_BODY_CHARS = 100_000;

const ensuredDirs = new Set<string>();

function resolveHistoryFile(options: HistoryOptions = {}): string {
  return resolve(options.file ?? process.env.HISTORY_FILE ?? DEFAULT_HISTORY_FILE);
}

/**
 * Appends are serialized so two concurrent writers can never interleave halfway
 * through a line and produce a corrupt JSONL row.
 */
let chain: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const result = chain.then(task, task);
  chain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function ensureParentDir(file: string): Promise<void> {
  const dir = dirname(file);
  if (ensuredDirs.has(dir)) return;
  await mkdir(dir, { recursive: true });
  ensuredDirs.add(dir);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toHeaderRecord(headers: HeadersInit | undefined | null): Record<string, string> {
  if (!headers) return {};
  return Object.fromEntries(new Headers(headers).entries());
}

async function appendEntry(entry: HistoryEntry, options: HistoryOptions): Promise<void> {
  const file = resolveHistoryFile(options);
  await enqueue(async () => {
    await ensureParentDir(file);
    await appendFile(file, `${JSON.stringify(entry)}\n`, "utf8");
  });
}

/* ------------------------------------------------------------- write side */

/** Records one HTTP exchange. */
export async function recordHistory(
  request: HistoryRequest,
  response: HistoryResponse | null,
  options: HistoryOptions & { error?: string } = {},
): Promise<HttpHistoryEntry> {
  const entry: HttpHistoryEntry = {
    kind: "http",
    id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    request,
    response,
    ...(options.error ? { error: options.error } : {}),
  };

  await appendEntry(entry, options);
  return entry;
}

/** Records one model call: the transcript sent, and the assistant turn that came back. */
export async function recordLlmExchange(
  exchange: {
    sessionId?: string;
    request: LlmHistoryRequest;
    response: LlmHistoryResponse | null;
    error?: string;
  },
  options: HistoryOptions = {},
): Promise<LlmHistoryEntry> {
  const entry: LlmHistoryEntry = {
    kind: "llm",
    id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    ...(exchange.sessionId ? { sessionId: exchange.sessionId } : {}),
    request: exchange.request,
    response: exchange.response,
    ...(exchange.error ? { error: exchange.error } : {}),
  };

  await appendEntry(entry, options);
  return entry;
}

/* -------------------------------------------------------------- read side */

/** Reads the history file. Missing, torn or legacy lines are handled, never thrown. */
export async function readHistory(options: HistoryReadOptions = {}): Promise<HistoryEntry[]> {
  const file = resolveHistoryFile(options);

  const raw = await readFile(file, "utf8").catch(() => null);
  if (raw === null) return [];

  let entries: HistoryEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed) as HistoryEntry;
      // Entries written before the log carried a discriminator were all HTTP probes.
      if (!entry.kind) entry.kind = "http";
      entries.push(entry);
    } catch {
      // A torn last line from an interrupted write — ignore it.
    }
  }

  if (options.kind) entries = entries.filter((entry) => entry.kind === options.kind);

  const limit = options.limit ?? 0;
  if (limit > 0) {
    return options.order === "desc" ? entries.slice(-limit).reverse() : entries.slice(-limit);
  }
  return options.order === "desc" ? entries.reverse() : entries;
}

/** Removes entries. With `kind`, only that kind is dropped and the rest are kept. */
export async function clearHistory(options: HistoryReadOptions = {}): Promise<number> {
  const file = resolveHistoryFile(options);
  const removed = (await readHistory(options)).length;

  const survivors = options.kind
    ? (await readHistory({ ...options, kind: undefined })).filter((entry) => entry.kind !== options.kind)
    : [];

  await enqueue(async () => {
    await ensureParentDir(file);
    await writeFile(file, survivors.map((entry) => `${JSON.stringify(entry)}\n`).join(""), "utf8");
  });

  return removed;
}

/* ----------------------------------------------------------- fetch wrapper */

function describeRequest(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  maxBodyChars: number,
): HistoryRequest {
  const isRequest = typeof Request !== "undefined" && input instanceof Request;

  const url = input instanceof URL ? input.toString() : isRequest ? (input as Request).url : String(input);

  // `init` wins over the Request object, matching fetch's own precedence.
  const method = (init?.method ?? (isRequest ? (input as Request).method : "GET")).toUpperCase();
  const headers = {
    ...(isRequest ? toHeaderRecord((input as Request).headers) : {}),
    ...toHeaderRecord(init?.headers),
  };

  const rawBody = typeof init?.body === "string" ? init.body : undefined;
  const body = rawBody ? rawBody.slice(0, maxBodyChars) : undefined;

  return { method, url, headers, ...(body ? { body } : {}) };
}

/**
 * Wraps fetch so every exchange lands in the history file.
 *
 * The response handed back to the caller is the original, untouched one — recording
 * reads a clone, so streaming, `res.json()` and `res.text()` all still work.
 */
export function createHistoryFetch(options: HistoryFetchOptions = {}): typeof fetch {
  const delegate = options.delegate ?? fetch;
  const maxBody = options.maxBodyChars ?? DEFAULT_MAX_BODY_CHARS;

  const wrapped = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = input instanceof URL ? input.toString() : input instanceof Request ? input.url : String(input);

    if (options.shouldRecord && !options.shouldRecord(url)) {
      return delegate(input, init);
    }

    const request = describeRequest(input, init, maxBody);
    const started = performance.now();

    try {
      const response = await delegate(input, init);
      const clone = response.clone();
      const text = await clone.text();

      await recordHistory(
        request,
        {
          status: response.status,
          statusText: response.statusText,
          headers: Object.fromEntries(response.headers.entries()),
          body: text.slice(0, maxBody),
          bodyBytes: new TextEncoder().encode(text).length,
          durationMs: Math.round(performance.now() - started),
        },
        options,
      );

      return response;
    } catch (error) {
      await recordHistory(request, null, { ...options, error: errorMessage(error) });
      throw error;
    }
  };

  return wrapped as typeof fetch;
}

/* ------------------------------------------------------------------ routes */

/**
 * Handles `/api/history`. Returns null for any other path so it can be mounted
 * in one line ahead of the rest of the router:
 *
 *   const handled = await handleHistoryRequest(request);
 *   if (handled) return handled;
 *
 * Query: `?kind=http|llm`, `?limit=N`, `?order=asc|desc`. DELETE accepts the same filter.
 */
export async function handleHistoryRequest(
  request: Request,
  options: HistoryOptions = {},
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/api/history") return null;

  const requestedKind = url.searchParams.get("kind");
  const kind = requestedKind === "http" || requestedKind === "llm" ? requestedKind : undefined;

  if (request.method === "GET") {
    const entries = await readHistory({
      ...options,
      kind,
      limit: Number(url.searchParams.get("limit")) || 0,
      order: url.searchParams.get("order") === "desc" ? "desc" : "asc",
    });

    const counts = await readHistory(options);
    return Response.json({
      count: entries.length,
      totals: {
        all: counts.length,
        http: counts.filter((entry) => entry.kind === "http").length,
        llm: counts.filter((entry) => entry.kind === "llm").length,
      },
      entries,
    });
  }

  if (request.method === "DELETE") {
    return Response.json({ cleared: await clearHistory({ ...options, kind }) });
  }

  return Response.json({ error: `${request.method} not allowed on /api/history` }, { status: 405 });
}

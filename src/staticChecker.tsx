/**
 * Static checker — declarative, regex-based vulnerability checks.
 *
 * Give it a list of checks (JSON) and a target (base URL and/or an OpenAPI spec).
 * For every check it executes the curl command against the target and tests the
 * regex against the response body. A match means the vulnerability is present.
 *
 * Everything lives behind `runStaticChecks(checks, target, options?)` so it can be
 * imported by the server, a CLI, or an Electron shell without dragging anything else in.
 *
 * Check file shape (a single object, or an array of them):
 *   {
 *     "title": "BOLA: attacker can read another user's order",
 *     "description": "Any valid token can fetch any order id.",
 *     "curl": "curl -i '{{baseUrl}}/orders/1' -H 'Authorization: Bearer token-bob-xyz'",
 *     "regex": "\"owner\"\\s*:\\s*\"alice\"",
 *     "severity": 9.5
 *   }
 *
 * Notes / deliberate limits:
 * - Only JSON OpenAPI specs are supported (no YAML — convert first).
 * - The regex is tested against the RAW response exactly as `curl -i` prints it —
 *   status line, headers, blank line, then body — so rules that assert on
 *   `^content-type:` or `^set-cookie:` work. Default flags are `i`; PCRE-style inline
 *   modifiers (`(?im)`, `(?is)`) are hoisted into real flags, and `/pattern/flags` works too.
 * - curl is parsed, not shelled out: the request is replayed with fetch, which also
 *   makes it easy to log into the Burp-lite history via `options.fetchImpl`.
 */

import { readFile, stat } from "node:fs/promises";

/* ------------------------------------------------------------------ types */

export const SEVERITY_LABELS = ["Info", "Low", "Medium", "High", "Critical"] as const;
export type SeverityLabel = (typeof SEVERITY_LABELS)[number];

export interface CheckDefinition {
  /** What the vulnerability is, in one line. */
  title: string;
  /** Why it matters / how to confirm it. */
  description: string;
  /** A curl command to replay. `{{baseUrl}}` is substituted with the target URL. */
  curl: string;
  /** Regex tested against the response body. A match == vulnerable. */
  regex: string;
  /** Severity score out of 10. */
  severity: number;
}

/** A single check, an array of checks, raw JSON text, or a path to a JSON file. */
export type CheckInput = CheckDefinition | CheckDefinition[] | string;

export interface OpenApiLike {
  openapi?: string;
  swagger?: string;
  servers?: Array<{ url?: string }>;
  host?: string;
  basePath?: string;
  schemes?: string[];
  paths?: Record<string, unknown>;
}

/** The API under test: a base URL, a parsed OpenAPI spec, or both. */
export type TargetInput =
  | string
  | OpenApiLike
  | { url?: string; baseUrl?: string; spec?: string | OpenApiLike };

export interface StaticCheckOptions {
  /** Per-request timeout in ms. Default 10_000. */
  timeoutMs?: number;
  /** How many checks to run in parallel. Default 5. */
  concurrency?: number;
  /**
   * Rewrite the origin of absolute curl URLs to the target base URL.
   * Default true whenever a base URL is known — checks written against
   * localhost then run against a staging host keep working.
   */
  rewriteOrigin?: boolean;
  /** Force redirect handling on/off. Default: whatever `-L` in the curl says. */
  followRedirects?: boolean;
  /** Headers merged into every request (auth for the scanner itself, etc.). */
  extraHeaders?: Record<string, string>;
  /** Swap the fetch implementation — e.g. one that records into the history log. */
  fetchImpl?: typeof fetch;
  /** Cap on the evidence snippet length. Default 400. */
  maxEvidenceLength?: number;
  /** Fires as each check starts — lets a UI stream progress instead of waiting for the batch. */
  onCheckStart?: (check: CheckDefinition, index: number, total: number) => void;
  /** Fires as each check finishes, in completion order. */
  onCheckResult?: (result: StaticCheckResult, index: number, total: number) => void;
}

export interface ExecutedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export interface StaticCheckResult {
  id: string;
  title: string;
  description: string;
  severity: number;
  severityLabel: SeverityLabel;
  vulnerable: boolean;
  regex: string;
  request: ExecutedRequest;
  response?: {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    bodyBytes: number;
    durationMs: number;
    bodyPreview: string;
  };
  /** Snippet around the match, only when vulnerable. */
  evidence?: string;
  /** Reproducible curl for the request that was actually sent. */
  poc_curl: string;
  error?: string;
}

export interface StaticCheckFinding {
  id: string;
  title: string;
  description: string;
  severity: number;
  severityLabel: SeverityLabel;
  evidence: string;
  poc_curl: string;
  request: ExecutedRequest;
  response: { status: number; statusText: string; durationMs: number };
}

export interface StaticCheckReport {
  target: {
    baseUrl: string | null;
    endpointCount: number;
    source: "url" | "spec" | "none";
  };
  summary: {
    total: number;
    vulnerable: number;
    clean: number;
    errored: number;
    highestSeverity: number;
    bySeverity: Record<SeverityLabel, number>;
  };
  findings: StaticCheckFinding[];
  results: StaticCheckResult[];
  startedAt: string;
  durationMs: number;
}

/* ------------------------------------------------------------- constants */

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_CONCURRENCY = 5;
const DEFAULT_EVIDENCE_RADIUS = 100;
const DEFAULT_MAX_EVIDENCE = 400;
const BODY_PREVIEW_LENGTH = 2_000;
const MAX_BODY_BYTES = 2_000_000;

const FIELD_ALIASES: Record<keyof CheckDefinition, string[]> = {
  title: ["title", "name"],
  description: ["description", "desc"],
  curl: ["curl", "curl_command", "command"],
  regex: ["regex", "regexp", "pattern"],
  severity: ["severity", "severity_score", "score"],
};

const LITERAL_REGEX = /^\/(.+)\/([gimsuy]+)$/s;

/** Common names for the array when the file is an envelope rather than a bare list. */
const CHECK_LIST_KEYS = ["checks", "rules", "tests", "scans"];

/** PCRE/Python-style inline modifiers — `(?im)`, `(?is)`, `(?-i)` — which JS RegExp rejects. */
const INLINE_MODIFIERS = /\(\?([imsxu]*)(?:-([imsxu]*))?\)/g;

/* --------------------------------------------------------------- helpers */

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** `localhost:4321`, `api.example.com/v1`, `127.0.0.1:8080` — but not `checks.json` alone. */
function looksLikeHost(value: string): boolean {
  return /^(localhost|(\d{1,3}\.){3}\d{1,3}|[\w-]+(\.[\w-]+)+)(:\d+)?(\/|$)/i.test(value);
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "check"
  );
}

function severityLabel(score: number): SeverityLabel {
  if (score >= 9) return "Critical";
  if (score >= 7) return "High";
  if (score >= 4) return "Medium";
  if (score >= 1) return "Low";
  return "Info";
}

function getHeader(headers: Record<string, string>, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function toCurl(request: ExecutedRequest): string {
  const parts = ["curl -i", `-X ${request.method}`, shellQuote(request.url)];
  for (const [name, value] of Object.entries(request.headers)) {
    parts.push(`-H ${shellQuote(`${name}: ${value}`)}`);
  }
  if (request.body) parts.push(`--data-raw ${shellQuote(request.body)}`);
  return parts.join(" \\\n  ");
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const width = Math.max(1, Math.min(limit, items.length));
  let cursor = 0;
  await Promise.all(
    Array.from({ length: width }, async () => {
      while (cursor < items.length) {
        const index = cursor++;
        results[index] = await fn(items[index], index);
      }
    }),
  );
  return results;
}

/* ------------------------------------------------------------ check input */

/**
 * Rules files often wrap the list in an envelope (`{ "checks": [...] }`) rather than
 * being a bare array. Unwrap that instead of reporting a confusing "missing fields".
 */
function unwrapCheckList(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object") {
    const record = parsed as Record<string, unknown>;
    for (const key of CHECK_LIST_KEYS) {
      if (Array.isArray(record[key])) return record[key] as unknown[];
    }
  }
  return [parsed];
}

function normalizeCheck(raw: unknown, index: number): CheckDefinition {
  if (!raw || typeof raw !== "object") {
    throw new Error(`Check #${index + 1} must be an object, got ${typeof raw}.`);
  }
  const source = raw as Record<string, unknown>;
  const picked: Record<string, unknown> = {};
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    for (const alias of aliases) {
      if (source[alias] !== undefined) {
        picked[field] = source[alias];
        break;
      }
    }
  }

  const missing = (Object.keys(FIELD_ALIASES) as Array<keyof CheckDefinition>).filter(
    (field) => picked[field] === undefined || picked[field] === null || picked[field] === "",
  );
  if (missing.length > 0) {
    throw new Error(
      `Check #${index + 1}${picked.title ? ` ("${String(picked.title)}")` : ""} is missing: ${missing.join(", ")}.`,
    );
  }

  const severity = Number(picked.severity);
  if (!Number.isFinite(severity) || severity < 0 || severity > 10) {
    throw new Error(
      `Check #${index + 1} ("${String(picked.title)}") has an invalid severity (${String(picked.severity)}) — expected a number between 0 and 10.`,
    );
  }

  return {
    title: String(picked.title),
    description: String(picked.description),
    curl: String(picked.curl),
    regex: String(picked.regex),
    severity,
  };
}

async function parseJsonText(text: string, source: string): Promise<unknown> {
  const trimmed = text.trim();
  if (trimmed.startsWith("openapi:") || trimmed.startsWith("swagger:")) {
    throw new Error(`${source} looks like YAML — convert it to JSON first.`);
  }
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`Could not parse ${source} as JSON: ${(error as Error).message}`);
  }
}

/** Accepts an array, a single object, raw JSON text, or a path to a JSON file. */
export async function loadChecks(input: CheckInput): Promise<CheckDefinition[]> {
  let parsed: unknown;

  if (Array.isArray(input)) {
    parsed = input;
  } else if (typeof input === "object" && input !== null) {
    parsed = input;
  } else if (typeof input === "string") {
    const trimmed = input.trim();
    if (!trimmed) throw new Error("No checks provided.");
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      parsed = await parseJsonText(trimmed, "the checks JSON");
    } else {
      const text = await readFile(trimmed, "utf8").catch(() => {
        throw new Error(`Could not read checks file: ${trimmed}`);
      });
      parsed = await parseJsonText(text, `checks file "${trimmed}"`);
    }
  } else {
    throw new Error(`Unsupported checks input: ${String(input)}`);
  }

  const list = unwrapCheckList(parsed);
  if (list.length === 0) throw new Error("The checks file contains no checks.");
  return list.map((entry, index) => normalizeCheck(entry, index));
}

/* ---------------------------------------------------------------- target */

interface ResolvedTarget {
  baseUrl: string | null;
  endpointCount: number;
  source: "url" | "spec" | "none";
}

function isSpec(value: unknown): value is OpenApiLike {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return "paths" in candidate || "openapi" in candidate || "swagger" in candidate;
}

function specToTarget(spec: OpenApiLike, specUrl: string | null): ResolvedTarget {
  const endpointCount = spec.paths && typeof spec.paths === "object" ? Object.keys(spec.paths).length : 0;

  let baseUrl = spec.servers?.find((server) => typeof server?.url === "string" && server.url)?.url ?? null;

  if (!baseUrl && spec.host) {
    const scheme = spec.schemes?.[0] ?? "https";
    baseUrl = `${scheme}://${spec.host}${spec.basePath ?? ""}`;
  }

  // Server URLs like "/api/v1" are relative to wherever the spec was served from.
  if (baseUrl && !/^[a-z][a-z0-9+.-]*:\/\//i.test(baseUrl) && specUrl) {
    baseUrl = new URL(baseUrl, specUrl).toString();
  }
  if (!baseUrl && specUrl) baseUrl = new URL(specUrl).origin;

  return {
    baseUrl: baseUrl ? stripTrailingSlash(baseUrl) : null,
    endpointCount,
    source: "spec",
  };
}

async function loadSpec(
  location: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<OpenApiLike> {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(location)) {
    const response = await fetchImpl(location, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) {
      throw new Error(`Failed to fetch OpenAPI spec (${response.status} ${response.statusText}) from ${location}`);
    }
    const parsed = await parseJsonText(await response.text(), `OpenAPI spec at ${location}`);
    if (!isSpec(parsed)) throw new Error(`${location} does not look like an OpenAPI document.`);
    return parsed;
  }

  const text = await readFile(location, "utf8").catch(() => {
    throw new Error(`Could not read OpenAPI spec file: ${location}`);
  });
  const parsed = await parseJsonText(text, `OpenAPI spec file "${location}"`);
  if (!isSpec(parsed)) throw new Error(`"${location}" does not look like an OpenAPI document.`);
  return parsed;
}

async function resolveTarget(
  target: TargetInput | undefined,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<ResolvedTarget> {
  if (!target) return { baseUrl: null, endpointCount: 0, source: "none" };

  if (typeof target === "string") {
    const value = target.trim();
    if (!value) return { baseUrl: null, endpointCount: 0, source: "none" };

    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
      if (/\.(json|ya?ml)(\?.*)?$/i.test(value)) {
        return specToTarget(await loadSpec(value, fetchImpl, timeoutMs), value);
      }
      return { baseUrl: stripTrailingSlash(value), endpointCount: 0, source: "url" };
    }

    // A bare `host:port/path` also parses as a plausible filename, so prefer the
    // file when one actually exists on disk.
    if (looksLikeHost(value) && !(await fileExists(value))) {
      return resolveTarget(`http://${value}`, fetchImpl, timeoutMs);
    }

    return specToTarget(await loadSpec(value, fetchImpl, timeoutMs), null);
  }

  if (isSpec(target)) return specToTarget(target, null);

  const composite = target as { url?: string; baseUrl?: string; spec?: string | OpenApiLike };
  let baseUrl: string | null = null;
  let endpointCount = 0;
  let source: ResolvedTarget["source"] = "none";

  const explicitUrl = composite.url ?? composite.baseUrl;
  if (explicitUrl) {
    baseUrl = stripTrailingSlash(explicitUrl);
    source = "url";
  }

  if (composite.spec) {
    let spec: OpenApiLike;
    if (typeof composite.spec === "string") {
      const trimmed = composite.spec.trim();
      spec = trimmed.startsWith("{")
        ? ((await parseJsonText(trimmed, "the inline OpenAPI spec")) as OpenApiLike)
        : await loadSpec(trimmed, fetchImpl, timeoutMs);
    } else {
      spec = composite.spec;
    }
    const derived = specToTarget(spec, null);
    endpointCount = derived.endpointCount;
    if (!baseUrl) {
      baseUrl = derived.baseUrl;
      source = "spec";
    }
  }

  return { baseUrl, endpointCount, source };
}

/* ------------------------------------------------------------ curl parser */

const SHORT_VALUE_FLAGS = new Set(["X", "H", "d", "u", "b", "A", "e", "m", "o", "w", "F", "T", "x"]);

/** Short flags that stand alone, and so can be clustered — `-Iv`, `-sSL`, `-iL`. */
const BOOLEAN_SHORT_FLAGS = new Set(["i", "s", "S", "v", "k", "L", "I", "G", "N", "f", "n"]);

/** Splits clustered boolean short flags so `-Iv` is handled as `-I` plus `-v`. */
function expandShortFlags(tokens: string[]): string[] {
  const expanded: string[] = [];
  for (const token of tokens) {
    if (/^-[A-Za-z]{2,}$/.test(token) && [...token.slice(1)].every((char) => BOOLEAN_SHORT_FLAGS.has(char))) {
      for (const char of token.slice(1)) expanded.push(`-${char}`);
    } else {
      expanded.push(token);
    }
  }
  return expanded;
}

const IGNORED_VALUE_FLAGS = new Set([
  "-o", "--output", "-w", "--write-out", "--connect-timeout",
  "-x", "--proxy", "--retry", "--retry-delay", "--cacert", "--cert", "--key",
  "--resolve", "--interface", "-T", "--upload-file", "-F", "--form",
  // These take a value too — without them `--tls-max 1.0` leaks "1.0" as the URL.
  "--tls-max", "--ciphers", "--cert-type", "--key-type", "--proto",
  "--proto-default", "--connect-to", "--limit-rate", "--max-filesize",
]);

interface ParsedCurl {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  followRedirects: boolean;
  /** From `--max-time` / `-m`, in milliseconds. */
  maxTimeMs?: number;
}

/** Shell-ish tokenizer: handles quotes, escapes and `\`-newline continuations. */
export function tokenizeCurl(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let started = false;
  let i = 0;

  const flush = () => {
    if (started) {
      tokens.push(current);
      current = "";
      started = false;
    }
  };

  while (i < command.length) {
    const char = command[i];

    if (char === "\\") {
      const next = command[i + 1];
      if (next === "\n") {
        i += 2;
        continue;
      }
      if (next === "\r" && command[i + 2] === "\n") {
        i += 3;
        continue;
      }
      if (next !== undefined) {
        current += next;
        started = true;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }

    // Bash ANSI-C quoting: $'...' with escape sequences. `$` is the quote introducer.
    if (char === "$" && command[i + 1] === "'") {
      i += 2;
      while (i < command.length && command[i] !== "'") {
        if (command[i] === "\\" && i + 1 < command.length) {
          const escaped = command[i + 1];
          current += escaped === "n" ? "\n" : escaped === "r" ? "\r" : escaped === "t" ? "\t" : escaped;
          i += 2;
          continue;
        }
        current += command[i];
        i += 1;
      }
      i += 1;
      started = true;
      continue;
    }

    if (char === "'") {
      i += 1;
      while (i < command.length && command[i] !== "'") {
        current += command[i];
        i += 1;
      }
      i += 1;
      started = true;
      continue;
    }

    if (char === '"') {
      i += 1;
      while (i < command.length && command[i] !== '"') {
        if (command[i] === "\\" && i + 1 < command.length && '"$`\\\n'.includes(command[i + 1])) {
          if (command[i + 1] !== "\n") current += command[i + 1];
          i += 2;
          continue;
        }
        current += command[i];
        i += 1;
      }
      i += 1;
      started = true;
      continue;
    }

    if (char === " " || char === "\t" || char === "\n" || char === "\r") {
      flush();
      i += 1;
      continue;
    }

    current += char;
    started = true;
    i += 1;
  }

  flush();
  return tokens;
}

function encodeFormValue(input: string): string {
  const separator = input.indexOf("=");
  if (separator === -1) return encodeURIComponent(input);
  return `${input.slice(0, separator)}=${encodeURIComponent(input.slice(separator + 1))}`;
}

/** Parses a curl command into an executable request. Never throws on unknown flags. */
export function parseCurl(command: string): ParsedCurl {
  const tokens = expandShortFlags(tokenizeCurl(command));
  const curlIndex = tokens.indexOf("curl");
  const start = curlIndex === -1 ? 0 : curlIndex + 1;

  const headers: Record<string, string> = {};
  const dataParts: string[] = [];
  const encodedParts: string[] = [];
  let method: string | undefined;
  let url = "";
  let followRedirects = false;
  let forceGet = false;
  let jsonBody = false;
  let maxTimeMs: number | undefined;

  for (let i = start; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token) continue;

    let flag = token;
    let inline: string | undefined;

    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      if (eq !== -1) {
        flag = token.slice(0, eq);
        inline = token.slice(eq + 1);
      }
    } else if (token.length > 2 && token.startsWith("-") && !token.startsWith("--") && SHORT_VALUE_FLAGS.has(token[1])) {
      flag = token.slice(0, 2);
      inline = token.slice(2);
    }

    const value = (): string => {
      if (inline !== undefined) return inline;
      i += 1;
      return tokens[i] ?? "";
    };

    switch (flag) {
      case "-X":
      case "--request":
        method = value().toUpperCase();
        break;
      case "-H":
      case "--header": {
        const header = value();
        const separator = header.indexOf(":");
        if (separator === -1) break;
        const name = header.slice(0, separator).trim();
        const headerValue = header.slice(separator + 1).trim();
        if (name) headers[name] = headerValue;
        break;
      }
      case "-d":
      case "--data":
      case "--data-raw":
      case "--data-ascii":
      case "--data-binary":
        dataParts.push(value());
        break;
      case "--data-urlencode":
        encodedParts.push(encodeFormValue(value()));
        break;
      case "--json":
        dataParts.push(value());
        jsonBody = true;
        break;
      case "-u":
      case "--user": {
        const credentials = value();
        headers["Authorization"] = `Basic ${btoa(credentials)}`;
        break;
      }
      case "-b":
      case "--cookie": {
        const cookie = value();
        if (cookie.includes("=")) headers["Cookie"] = cookie;
        break;
      }
      case "-A":
      case "--user-agent":
        headers["User-Agent"] = value();
        break;
      case "-e":
      case "--referer":
        headers["Referer"] = value();
        break;
      case "-L":
      case "--location":
        followRedirects = true;
        break;
      case "-m":
      case "--max-time": {
        const seconds = Number(value());
        if (Number.isFinite(seconds) && seconds > 0) maxTimeMs = Math.round(seconds * 1000);
        break;
      }
      case "-I":
      case "--head":
        method = "HEAD";
        break;
      case "-G":
      case "--get":
        forceGet = true;
        break;
      case "--url":
        url = value();
        break;
      case "-i":
      case "--include":
      case "-k":
      case "--insecure":
      case "-s":
      case "--silent":
      case "-S":
      case "--show-error":
      case "-v":
      case "--verbose":
      case "--compressed":
      case "--no-buffer":
      case "-N":
        break;
      default:
        if (IGNORED_VALUE_FLAGS.has(flag)) {
          value();
        } else if (!flag.startsWith("-") && !url) {
          url = flag;
        }
        break;
    }
  }

  let body = [...dataParts, ...encodedParts].join("&") || undefined;

  if (forceGet) {
    if (body) {
      url += `${url.includes("?") ? "&" : "?"}${body}`;
      body = undefined;
    }
    method = "GET";
  }

  const resolvedMethod = method ?? (body ? "POST" : "GET");

  if (body && getHeader(headers, "content-type") === undefined) {
    headers["Content-Type"] = jsonBody ? "application/json" : "application/x-www-form-urlencoded";
  }

  return { method: resolvedMethod, url, headers, body, followRedirects, maxTimeMs };
}

/* ------------------------------------------------------ placeholder URLs */

const BASE_URL_PLACEHOLDERS = [
  /\{\{\s*base_?url\s*\}\}/gi,
  /\{\s*base_?url\s*\}/gi,
  /<%=\s*base_?url\s*%>/gi,
  /<base_?url>/gi,
  /\$\{base_?url\}/gi,
  /\$base_?url/gi,
];

/**
 * `{{httpBaseUrl}}` — the target with the scheme forced to http.
 *
 * Rules that exist to prove plaintext HTTP is served need to stay http even when the
 * scan target is https, otherwise "does not redirect to HTTPS" fires on an HTTPS target.
 */
const HTTP_BASE_URL_PLACEHOLDERS = [
  /\{\{\s*http_?base_?url\s*\}\}/gi,
  /\{\s*http_?base_?url\s*\}/gi,
  /<%=\s*http_?base_?url\s*%>/gi,
  /\$\{http_?base_?url\}/gi,
];

/** A URL that already names the target by placeholder must not be re-targeted. */
const ANY_BASE_URL_PLACEHOLDER = /\{\{[^}]*base_?url[^}]*\}\}|<%=[^%]*base_?url[^%]*%>|<[^<>]*base_?url[^<>]*>/i;

function substituteBaseUrl(value: string, baseUrl: string): string {
  const httpBaseUrl = baseUrl.replace(/^https:/i, "http:");
  let result = value;
  for (const pattern of HTTP_BASE_URL_PLACEHOLDERS) result = result.replace(pattern, httpBaseUrl);
  for (const pattern of BASE_URL_PLACEHOLDERS) result = result.replace(pattern, baseUrl);
  return result;
}

function absolutize(url: string, baseUrl: string | null, rewriteOrigin: boolean): string {
  if (!baseUrl) return url;

  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    const base = new URL(baseUrl);
    const prefix = stripTrailingSlash(`${base.origin}${base.pathname.replace(/\/+$/, "")}`);
    return `${prefix}/${url.replace(/^\/+/, "")}`;
  }

  if (!rewriteOrigin) return url;

  const parsed = new URL(url);
  const base = new URL(baseUrl);
  const suffix = stripTrailingSlash(`${base.origin}${base.pathname.replace(/\/+$/, "")}`);
  return `${suffix}${parsed.pathname}${parsed.search}${parsed.hash}`;
}

/* ------------------------------------------------------------- regex run */

/**
 * Compiles a check's regex.
 *
 * Most scanner rule sets are authored in PCRE/Python style and lead with inline
 * modifiers — `(?im)`, `(?is)`, `(?-i)` — which JavaScript RegExp rejects outright.
 * Those are hoisted into real flags here so the rules run as written.
 */
function compileRegex(pattern: string): RegExp {
  const literal = LITERAL_REGEX.exec(pattern);
  if (literal) return new RegExp(literal[1], literal[2].replace(/[gy]/g, "") || "i");

  const flags = new Set(["i"]);

  for (const modifier of pattern.matchAll(INLINE_MODIFIERS)) {
    for (const flag of modifier[1] ?? "") {
      if (flag === "x") throw new Error("the (?x) extended modifier has no JavaScript equivalent");
      flags.add(flag);
    }
    for (const flag of modifier[2] ?? "") flags.delete(flag);
  }

  return new RegExp(pattern.replace(INLINE_MODIFIERS, ""), [...flags].join(""));
}

/**
 * Rebuilds what `curl -i` prints: status line, headers, blank line, body.
 *
 * Rules that assert on `^content-type:` / `^set-cookie:` / `^location:` are testing the
 * response headers, so the regex has to see them. CRLF endings match curl byte-for-byte,
 * which is what patterns like `[^\r\n]*` are written against.
 */
function toRawResponse(status: number, statusText: string, headers: Headers, body: string): string {
  const statusLine = `HTTP/1.1 ${status}${statusText ? ` ${statusText}` : ""}`;
  const lines = [statusLine, ...[...headers.entries()].map(([name, value]) => `${name}: ${value}`)];
  return `${lines.join("\r\n")}\r\n\r\n${body}`;
}

/* --------------------------------------------------------------- runner */

interface RunContext {
  resolved: ResolvedTarget;
  options: StaticCheckOptions;
  timeoutMs: number;
  fetchImpl: typeof fetch;
}

async function runCheck(check: CheckDefinition, context: RunContext): Promise<StaticCheckResult> {
  const { resolved, options, timeoutMs, fetchImpl } = context;
  const baseUrl = resolved.baseUrl;
  const rewriteOrigin = options.rewriteOrigin ?? true;
  const maxEvidence = options.maxEvidenceLength ?? DEFAULT_MAX_EVIDENCE;
  const id = slugify(check.title);
  const severity = check.severity;

  const base: Omit<StaticCheckResult, "vulnerable" | "poc_curl" | "request"> = {
    id,
    title: check.title,
    description: check.description,
    severity,
    severityLabel: severityLabel(severity),
    regex: check.regex,
  };

  let request: ExecutedRequest = { method: "GET", url: "", headers: {} };
  let poc = "";

  try {
    const parsed = parseCurl(check.curl);

    if (!parsed.url) throw new Error("The curl command has no URL.");

    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(parsed.headers)) {
      headers[name] = baseUrl ? substituteBaseUrl(value, baseUrl) : value;
    }
    for (const [name, value] of Object.entries(options.extraHeaders ?? {})) headers[name] = value;

    const rawUrl = baseUrl ? substituteBaseUrl(parsed.url, baseUrl) : parsed.url;
    // A placeholder already names the target, so don't rewrite the origin on top of it —
    // otherwise `{{httpBaseUrl}}` gets forced back to the target's (https) scheme.
    const url =
      baseUrl && !ANY_BASE_URL_PLACEHOLDER.test(parsed.url) ? absolutize(rawUrl, baseUrl, rewriteOrigin) : rawUrl;

    const body = parsed.body && baseUrl ? substituteBaseUrl(parsed.body, baseUrl) : parsed.body;
    const hasBody = Boolean(body) && parsed.method !== "GET" && parsed.method !== "HEAD";

    request = { method: parsed.method, url, headers, ...(hasBody ? { body } : {}) };
    poc = toCurl(request);

    const redirect = options.followRedirects ?? parsed.followRedirects;
    const started = performance.now();

    const response = await fetchImpl(url, {
      method: parsed.method,
      headers,
      body: hasBody ? body : undefined,
      redirect: redirect ? "follow" : "manual",
      signal: AbortSignal.timeout(parsed.maxTimeMs ?? timeoutMs),
    });

    const text = (await response.text()).slice(0, MAX_BODY_BYTES);
    const raw = toRawResponse(response.status, response.statusText, response.headers, text);
    const durationMs = Math.round(performance.now() - started);
    const responseHeaders = Object.fromEntries(response.headers.entries());

    const result: StaticCheckResult = {
      ...base,
      vulnerable: false,
      request,
      poc_curl: poc,
      response: {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
        bodyBytes: new TextEncoder().encode(text).length,
        durationMs,
        bodyPreview: text.slice(0, BODY_PREVIEW_LENGTH),
      },
    };

    let match: RegExpExecArray | null;
    try {
      match = compileRegex(check.regex).exec(raw);
    } catch (error) {
      return { ...result, error: `Invalid regex: ${(error as Error).message}` };
    }

    if (!match) return result;

    const radius = Math.max(0, Math.floor((maxEvidence - match[0].length) / 2)) || DEFAULT_EVIDENCE_RADIUS;
    const from = Math.max(0, match.index - radius);
    const to = Math.min(raw.length, match.index + match[0].length + radius);
    const evidence = `${from > 0 ? "…" : ""}${raw.slice(from, to)}${to < raw.length ? "…" : ""}`.slice(0, maxEvidence);

    return { ...result, vulnerable: true, evidence };
  } catch (error) {
    return {
      ...base,
      vulnerable: false,
      request,
      poc_curl: poc,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function toFinding(result: StaticCheckResult): StaticCheckFinding {
  return {
    id: result.id,
    title: result.title,
    description: result.description,
    severity: result.severity,
    severityLabel: result.severityLabel,
    evidence: result.evidence ?? "",
    poc_curl: result.poc_curl,
    request: result.request,
    response: {
      status: result.response?.status ?? 0,
      statusText: result.response?.statusText ?? "",
      durationMs: result.response?.durationMs ?? 0,
    },
  };
}

/**
 * Runs every check against the target and reports what matched.
 *
 * @param checks  A check object, an array of them, raw JSON, or a path to a JSON file.
 * @param target  Base URL, parsed OpenAPI spec, spec file/URL, or `{ url, spec }`.
 */
export async function runStaticChecks(
  checks: CheckInput,
  target?: TargetInput,
  options: StaticCheckOptions = {},
): Promise<StaticCheckReport> {
  const startedAt = new Date();
  const started = performance.now();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;

  const checkList = await loadChecks(checks);
  const resolved = await resolveTarget(target, fetchImpl, timeoutMs);

  const total = checkList.length;
  const results = await mapWithConcurrency(checkList, options.concurrency ?? DEFAULT_CONCURRENCY, async (check, index) => {
    options.onCheckStart?.(check, index, total);
    const result = await runCheck(check, { resolved, options, timeoutMs, fetchImpl });
    options.onCheckResult?.(result, index, total);
    return result;
  });

  results.sort((a, b) => b.severity - a.severity || a.title.localeCompare(b.title));

  const findings = results.filter((result) => result.vulnerable).map(toFinding);

  const bySeverity = Object.fromEntries(SEVERITY_LABELS.map((label) => [label, 0])) as Record<SeverityLabel, number>;
  for (const result of results) {
    if (result.vulnerable) bySeverity[result.severityLabel] += 1;
  }

  return {
    target: resolved,
    summary: {
      total: results.length,
      vulnerable: findings.length,
      clean: results.filter((result) => !result.vulnerable && !result.error).length,
      errored: results.filter((result) => Boolean(result.error)).length,
      highestSeverity: findings.reduce((max, finding) => Math.max(max, finding.severity), 0),
      bySeverity,
    },
    findings,
    results,
    startedAt: startedAt.toISOString(),
    durationMs: Math.round(performance.now() - started),
  };
}

/* ------------------------------------------------------------------- CLI */

function printReport(report: StaticCheckReport): void {
  const target = report.target.baseUrl ?? "(no target URL resolved)";
  console.log(`\nStatic check — ${target}`);
  if (report.target.endpointCount) {
    console.log(`OpenAPI spec loaded: ${report.target.endpointCount} path(s) available`);
  }
  console.log("");

  for (const result of report.results) {
    const status = result.response ? `${result.response.status} ${result.response.statusText}`.trim() : "no response";
    const flag = result.error ? "ERROR" : result.vulnerable ? "VULNERABLE" : "clean";
    console.log(`[${flag.padEnd(10)}] ${result.severity.toFixed(1).padStart(4)}/10 ${result.severityLabel.padEnd(8)} ${result.title}`);
    console.log(`             ${result.request.method} ${result.request.url} -> ${status}${result.error ? ` (${result.error})` : ""}`);
    if (result.evidence) console.log(`             evidence: ${result.evidence.replace(/\s+/g, " ").slice(0, 160)}`);
  }

  const { summary } = report;
  console.log(
    `\n${summary.total} checks — ${summary.vulnerable} vulnerable, ${summary.clean} clean, ${summary.errored} errored ` +
      `(highest severity ${summary.highestSeverity}/10) in ${report.durationMs}ms`,
  );
}

if (import.meta.main) {
  const [checksPath, targetArg] = process.argv.slice(2);
  if (!checksPath) {
    console.error("usage: bun run src/staticChecker.tsx <checks.json> [base-url|openapi.json] [--json]");
    process.exit(1);
  }

  const asJson = process.argv.includes("--json");

  runStaticChecks(checksPath, targetArg)
    .then((report) => {
      if (asJson) console.log(JSON.stringify(report, null, 2));
      else printReport(report);
      process.exit(report.summary.vulnerable > 0 ? 2 : 0);
    })
    .catch((error: unknown) => {
      console.error(`Static check failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    });
}

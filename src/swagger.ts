/**
 * Swagger / OpenAPI injection.
 *
 * The scanner accepts either an origin or a spec:
 *   - a spec file  -> we enumerate the surface it describes
 *   - a bare URL   -> we fall back to `default_swagger.json` and let the URL
 *                     supply the origin
 *
 * Enumerating the surface is what turns a spec into a site map: every
 * `method + path` pair becomes an endpoint, with path parameters filled from
 * their `example` so the entry is directly probeable.
 *
 *   const api = await resolveApi("https://api.example.test");     // -> default spec
 *   const api = await resolveApi("./openapi.json");               // -> that spec
 *   const api = await resolveApi({ target, swagger: "./spec.json" });
 */

import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/* ------------------------------------------------------------------ types */

const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;
type HttpMethod = (typeof HTTP_METHODS)[number];

type PathParameter = { name?: string; example?: unknown; schema?: { example?: unknown; default?: unknown } };
type Operation = { operationId?: string; summary?: string; parameters?: PathParameter[] };
type PathItem = Partial<Record<HttpMethod, Operation>> & { parameters?: PathParameter[] };

export interface OpenApiDocument {
  openapi?: string;
  swagger?: string;
  info?: { title?: string; version?: string; description?: string };
  servers?: Array<{ url?: string; description?: string }>;
  host?: string;
  basePath?: string;
  schemes?: string[];
  paths?: Record<string, PathItem>;
}

export interface ApiEndpoint {
  method: string;
  /** As written in the spec, e.g. `/api/users/{id}` */
  path: string;
  /** Path parameters filled from their example, e.g. `/api/users/101` */
  examplePath: string;
  operationId?: string;
  summary?: string;
}

export interface ResolvedApi {
  source: "file" | "default";
  document: OpenApiDocument;
  title: string;
  version: string;
  /** The origin the checks will run against, if we could work one out. */
  baseUrl: string | null;
  endpoints: ApiEndpoint[];
}

export interface ApiInput {
  /** Origin to scan. Wins over anything in the spec. */
  target?: string;
  /** Path to a swagger/openapi file. */
  swagger?: string;
}

/* --------------------------------------------------------------- defaults */

const HERE = dirname(fileURLToPath(import.meta.url));

/** Fallback surface, used whenever only an origin is supplied. */
export const DEFAULT_SWAGGER_PATH = resolve(HERE, "default_swagger.json");

/* ---------------------------------------------------------------- loading */

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function looksLikeSpec(value: unknown): value is OpenApiDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return "paths" in candidate || "openapi" in candidate || "swagger" in candidate;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** Reads and validates an OpenAPI document from disk or over HTTP. */
export async function loadSwagger(location: string): Promise<OpenApiDocument> {
  let text: string;

  if (isHttpUrl(location)) {
    const response = await fetch(location, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`Could not fetch spec (${response.status} ${response.statusText}) from ${location}`);
    text = await response.text();
  } else {
    const path = resolve(location);
    text = await readFile(path, "utf8").catch(() => {
      throw new Error(`Could not read spec file: ${path}`);
    });
  }

  const trimmed = text.trim();
  if (trimmed.startsWith("openapi:") || trimmed.startsWith("swagger:")) {
    throw new Error(`${location} is YAML — convert it to JSON first.`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`${location} is not valid JSON: ${(error as Error).message}`);
  }

  if (!looksLikeSpec(parsed)) throw new Error(`${location} does not look like an OpenAPI document (no "paths").`);
  return parsed;
}

/* ------------------------------------------------------------ enumeration */

/** Fills `/api/users/{id}` from the parameter's example, so the endpoint is probeable. */
function fillPathParameters(path: string, parameters: PathParameter[]): string {
  return path.replace(/\{([^}]+)\}/g, (whole, name: string) => {
    const parameter = parameters.find((entry) => entry.name === name);
    const value = parameter?.example ?? parameter?.schema?.example ?? parameter?.schema?.default;
    return value === undefined || value === null ? whole : encodeURIComponent(String(value));
  });
}

/** Every `method + path` pair the document declares. */
export function enumerateEndpoints(document: OpenApiDocument): ApiEndpoint[] {
  const endpoints: ApiEndpoint[] = [];

  for (const [path, item] of Object.entries(document.paths ?? {})) {
    if (!item || typeof item !== "object") continue;

    for (const method of HTTP_METHODS) {
      const operation = item[method];
      if (!operation || typeof operation !== "object") continue;

      const parameters = [...(item.parameters ?? []), ...(operation.parameters ?? [])];
      endpoints.push({
        method: method.toUpperCase(),
        path,
        examplePath: fillPathParameters(path, parameters),
        ...(operation.operationId ? { operationId: operation.operationId } : {}),
        ...(operation.summary ? { summary: operation.summary } : {}),
      });
    }
  }

  return endpoints.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

/* ------------------------------------------------------------- resolution */

function baseUrlFromSpec(document: OpenApiDocument, fallback: string | null): string | null {
  const server = document.servers?.find((entry) => typeof entry?.url === "string" && entry.url);
  if (server?.url) return server.url.replace(/\/+$/, "");

  if (document.host) {
    const scheme = document.schemes?.[0] ?? "https";
    return `${scheme}://${document.host}${document.basePath ?? ""}`.replace(/\/+$/, "");
  }

  return fallback;
}

/**
 * Describes a spec that is already parsed — e.g. one the browser just uploaded, which
 * never touches disk and so can't go through `loadSwagger`.
 */
export function inspectSpec(document: OpenApiDocument, source: "file" | "default" = "file"): ResolvedApi {
  const endpoints = enumerateEndpoints(document);
  if (endpoints.length === 0) throw new Error("That document declares no endpoints.");

  return {
    source,
    document,
    title: document.info?.title ?? "Untitled API",
    version: document.info?.version ?? "unknown",
    baseUrl: baseUrlFromSpec(document, null),
    endpoints,
  };
}

/**
 * Works out what to scan and which surface to assume.
 *
 * A bare origin gets the default spec; a path (or spec URL) gets itself.
 */
export async function resolveApi(input: string | ApiInput): Promise<ResolvedApi> {
  let target: string | undefined;
  let swagger: string | undefined;

  if (typeof input === "string") {
    if (isHttpUrl(input)) target = input;
    else swagger = input;
  } else {
    target = input.target;
    swagger = input.swagger;
  }

  // `scan.ts ./openapi.json` — if the path is really a spec, treat it as one.
  if (!swagger && target && !isHttpUrl(target) && (await fileExists(target))) {
    swagger = target;
    target = undefined;
  }

  const usingDefault = !swagger;
  const location = swagger ?? DEFAULT_SWAGGER_PATH;

  let resolved: ResolvedApi;
  try {
    resolved = inspectSpec(await loadSwagger(location), usingDefault ? "default" : "file");
  } catch (error) {
    if (usingDefault) throw error;
    throw new Error(`${location}: ${(error as Error).message}`);
  }

  return { ...resolved, baseUrl: target ? target.replace(/\/+$/, "") : resolved.baseUrl };
}

/**
 * Conversation persistence.
 *
 * Every agent run writes a session so the transcript survives the process — which is
 * what makes "explain that finding to me" possible hours later, and what lets a user
 * pick the assessment back up and extend it.
 *
 * Storage is one JSONL file per conversation in `data/sessions/` (gitignored):
 *
 *   {"type":"session","id":"a3f91b2c",...}      <- header, written once
 *   {"type":"message","message":{...}}           <- one line per agent message
 *   {"type":"message","message":{...}}
 *
 * Append-only, so a crash can lose at most the last line, and an interrupted write
 * can never corrupt the messages before it.
 */

import { appendFile, mkdir, readFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

/* ------------------------------------------------------------------ types */

export interface SessionHeader {
  id: string;
  createdAt: string;
  /** The origin this conversation is scoped to. Resuming reuses it, so scope cannot drift. */
  target: string;
  model: string;
  findingsPath: string;
}

export interface SessionSummary extends SessionHeader {
  updatedAt: string;
  messageCount: number;
}

export interface LoadedSession {
  header: SessionHeader;
  messages: unknown[];
  path: string;
}

/* ---------------------------------------------------------------- storage */

/** Read per call, not at import time, so tests and tooling can redirect it. */
function sessionDir(): string {
  return resolve(process.env.SESSION_DIR ?? "data/sessions");
}

export function sessionsDir(): string {
  return sessionDir();
}

export function sessionPath(id: string): string {
  return join(sessionDir(), `${id}.jsonl`);
}

/** Short and typeable — these get pasted into `--resume`. */
export function newSessionId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 8);
}

/**
 * Appends are serialised so two concurrent writers can never interleave halfway
 * through a line.
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

/* ------------------------------------------------------------------ write */

export async function createSession(header: SessionHeader): Promise<SessionHeader> {
  const line = `${JSON.stringify({ type: "session", ...header })}\n`;
  await enqueue(async () => {
    await mkdir(sessionDir(), { recursive: true });
    await appendFile(sessionPath(header.id), line, "utf8");
  });
  return header;
}

export async function appendMessage(sessionId: string, message: unknown): Promise<void> {
  const line = `${JSON.stringify({ type: "message", message })}\n`;
  await enqueue(async () => {
    await mkdir(sessionDir(), { recursive: true });
    await appendFile(sessionPath(sessionId), line, "utf8");
  });
}

/* ------------------------------------------------------------------- read */

export async function listSessions(): Promise<SessionSummary[]> {
  const names = await readdir(sessionDir()).catch(() => [] as string[]);
  const summaries: SessionSummary[] = [];

  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const path = join(sessionDir(), name);
    const raw = await readFile(path, "utf8").catch(() => null);
    if (!raw) continue;

    const lines = raw.split("\n").filter((line) => line.trim());
    let header: SessionHeader | undefined;
    let messageCount = 0;

    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as { type?: string; message?: unknown };
        if (entry.type === "session") header = entry as unknown as SessionHeader;
        else if (entry.type === "message" && entry.message) messageCount += 1;
      } catch {
        // A torn final line from an interrupted write — ignore it.
      }
    }
    if (!header) continue;

    const info = await stat(path).catch(() => null);
    summaries.push({
      ...header,
      updatedAt: info ? info.mtime.toISOString() : header.createdAt,
      messageCount,
    });
  }

  return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function loadSession(id: string): Promise<LoadedSession> {
  const path = sessionPath(id);
  const raw = await readFile(path, "utf8").catch(() => {
    throw new Error(`No such session: ${id}. Run with --sessions to list them.`);
  });

  let header: SessionHeader | undefined;
  const messages: unknown[] = [];

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as { type?: string; message?: unknown };
      if (entry.type === "session") header = entry as unknown as SessionHeader;
      else if (entry.type === "message" && entry.message) messages.push(entry.message);
    } catch {
      // Skip a torn line rather than losing the whole conversation.
    }
  }

  if (!header) throw new Error(`Session file ${path} has no header — it looks corrupt.`);
  return { header, messages, path };
}

/** Accepts an id, or `last` for the most recently updated conversation. */
export async function resolveSessionId(reference: string): Promise<string> {
  if (reference && reference !== "last") return reference;

  const [newest] = await listSessions();
  if (!newest) throw new Error("No saved sessions yet — run a scan first.");
  return newest.id;
}

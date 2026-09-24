/**
 * Offline self-test for the agent loop.
 *
 * pi-ai's `faux` provider lets us script exactly what the model "says", so every
 * path — tool execution, the findings file, and all three stop conditions — can be
 * verified with no DeepSeek key and no outbound network.
 *
 *   bun run src/server.ts           # the demo target, in another shell
 *   bun run src/agent-selftest.ts
 */

import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { readFile, rm } from "node:fs/promises";
import { assertSafeCurl, runAgent } from "./agent";
import { readHistory, handleHistoryRequest } from "./history";
import { listSessions, loadSession, resolveSessionId } from "./session";

const TARGET = process.env.TARGET_URL ?? "http://127.0.0.1:5001";
const FINDINGS = "findings.selftest.md";
const SESSION_DIR = "data/sessions.selftest";
const HISTORY_FILE = "data/history.selftest.jsonl";
const CURL = "toolUse" as never;

// Redirect both stores so the test never touches real conversations or real history.
process.env.SESSION_DIR = SESSION_DIR;
process.env.HISTORY_FILE = HISTORY_FILE;
await rm(SESSION_DIR, { recursive: true, force: true });
await rm(HISTORY_FILE, { force: true });

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
}

function scripted() {
  const faux = fauxProvider({ provider: "deepseek", api: "openai-completions", models: [{ id: "faux-scripted" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  // The handle has no stream function of its own — the Models collection dispatches
  // to whichever provider owns the model, which is how the real DeepSeek path works too.
  return { faux, model: faux.getModel(), streamFn: models.streamSimple.bind(models) };
}

/* ------------------------------- 1. happy path ------------------------------ */

console.log("\n1. happy path: run_curl -> record_finding -> finish_scan");
await rm(FINDINGS, { force: true });

const happy = scripted();
const trace: string[] = [];
happy.faux.setResponses([
  fauxAssistantMessage(
    [fauxToolCall("run_curl", { command: `curl -i '${TARGET}/api/orders/1'`, reason: "BOLA check" })],
    { stopReason: CURL },
  ),
  fauxAssistantMessage(
    [
      fauxToolCall("record_finding", {
        title: "BOLA: any caller can read any order",
        severity: "Critical",
        endpoint: "GET /api/orders/1",
        evidence: 'GET /api/orders/1 -> 200 {"id":"1","owner":"asha","card_last4":"4242"}',
        remediation: "Enforce order.owner === auth.user, else 403.",
      }),
    ],
    { stopReason: CURL },
  ),
  fauxAssistantMessage([fauxToolCall("finish_scan", { summary: "One BOLA confirmed." })], { stopReason: CURL }),
]);

const happyResult = await runAgent({
  target: TARGET,
  model: happy.model,
  streamFn: happy.streamFn,
  findingsPath: FINDINGS,
  onEvent: (line) => trace.push(line),
  onDelta: () => {},
});

check("stopped via finish_scan", happyResult.stopped === "finished", happyResult.stopped);
check("one finding recorded", happyResult.findings === 1, String(happyResult.findings));
check("curl actually executed", trace.some((line) => line.includes("curl") && line.includes("exit 0")));

const written = await readFile(FINDINGS, "utf8").catch(() => "");
check("findings.md created", written.length > 0);
check("findings.md has a header", written.includes(`# Findings — ${new URL(TARGET).origin}`));
check("finding body written", written.includes("## 1. BOLA: any caller can read any order — Critical"));
check("evidence preserved", written.includes("card_last4"));
check("remediation preserved", written.includes("order.owner === auth.user"));

/* ------------------------------- 2. STOP word ------------------------------- */

console.log("\n2. stop word: assistant replies with a bare STOP");
const stopper = scripted();
stopper.faux.setResponses([fauxAssistantMessage("STOP")]);

const stopResult = await runAgent({
  target: TARGET,
  model: stopper.model,
  streamFn: stopper.streamFn,
  findingsPath: FINDINGS,
  onEvent: () => {},
  onDelta: () => {},
});

check("stopped via STOP", stopResult.stopped === "stop-word", stopResult.stopped);

/* ---------------------------- 3. turn budget -------------------------------- */

console.log("\n3. turn budget: model that keeps calling tools");
const looper = scripted();
// A model that only emits text stops on its own — the loop continues on tool calls.
// So the budget has to be exercised with a model that never stops calling tools.
looper.faux.setResponses(
  Array.from({ length: 10 }, () =>
    fauxAssistantMessage([fauxToolCall("run_curl", { command: `curl -i '${TARGET}/'`, reason: "loop" })], {
      stopReason: CURL,
    }),
  ),
);

const loopResult = await runAgent({
  target: TARGET,
  model: looper.model,
  streamFn: looper.streamFn,
  findingsPath: FINDINGS,
  maxTurns: 3,
  onEvent: () => {},
  onDelta: () => {},
});

check("stopped by turn budget", loopResult.stopped === "turn-limit", loopResult.stopped);
check("budget respected", loopResult.turns <= 3, `turns=${loopResult.turns}`);

/* --------------------------- 4. origin enforcement -------------------------- */

console.log("\n4. scope enforcement: curl aimed at another host");
const offTarget = scripted();
let seenByModel = "";
offTarget.faux.setResponses([
  fauxAssistantMessage(
    [fauxToolCall("run_curl", { command: "curl -i 'https://example.com/'", reason: "try to escape scope" })],
    { stopReason: CURL },
  ),
  (context: unknown) => {
    const messages = (context as { messages?: unknown[] }).messages ?? [];
    seenByModel = JSON.stringify(messages[messages.length - 1] ?? {});
    return fauxAssistantMessage("STOP");
  },
]);

await runAgent({
  target: TARGET,
  model: offTarget.model,
  streamFn: offTarget.streamFn,
  findingsPath: FINDINGS,
  onEvent: () => {},
  onDelta: () => {},
});

check("off-origin request refused", seenByModel.includes("scoped to"), seenByModel.slice(0, 120));

/* ----------------------------- 5. curl guardrails --------------------------- */

console.log("\n5. curl guardrails");
const rejected: Array<[string, string]> = [
  ["writes a file", "-o /etc/passwd"],
  ["uploads a file", "-T /etc/shadow"],
  ["reads a config file", "-K /etc/hosts"],
  ["reads a cookie jar", "-c /tmp/cookies.txt"],
  ["reads a local file via @", "--data @/etc/passwd"],
];
for (const [label, args] of rejected) {
  let threw = false;
  try {
    assertSafeCurl(["curl", ...args.split(" "), `${TARGET}/`]);
  } catch {
    threw = true;
  }
  check(`rejects curl that ${label}`, threw);
}

const allowed: Array<[string, string]> = [
  ["-o /dev/null", "curl -sS -D - -o /dev/null"],
  ["-D -", "curl -i -D -"],
  ["plain headers", "curl -i -H 'Origin: null'"],
];
for (const [label, command] of allowed) {
  let threw = false;
  try {
    assertSafeCurl(command.split(" "));
  } catch {
    threw = true;
  }
  check(`allows ${label}`, !threw);
}

/* ------------------------- 6. sessions: save, resume ------------------------ */

console.log("\n6. sessions: persistence and resume");
await rm(FINDINGS, { force: true });
// Scenarios 1-5 each started a session; isolate this one.
await rm(SESSION_DIR, { recursive: true, force: true });

const first = scripted();
first.faux.setResponses([
  fauxAssistantMessage([fauxToolCall("run_curl", { command: `curl -i '${TARGET}/'`, reason: "recon" })], {
    stopReason: CURL,
  }),
  fauxAssistantMessage([fauxToolCall("finish_scan", { summary: "Recon done." })], { stopReason: CURL }),
]);

const run1 = await runAgent({
  target: TARGET,
  model: first.model,
  streamFn: first.streamFn,
  findingsPath: FINDINGS,
  onEvent: () => {},
  onDelta: () => {},
});

const saved = await loadSession(run1.sessionId);
check("session file written", saved.messages.length === run1.transcript, `${saved.messages.length} vs ${run1.transcript}`);
check("header pins the target origin", saved.header.target === new URL(TARGET).origin, saved.header.target);
check("system prompt persisted", (saved.messages[0] as { role?: string })?.role === "system");
check("tool result persisted", JSON.stringify(saved.messages).includes("run_curl"));

const listed = await listSessions();
check("session appears in the listing", listed.some((entry) => entry.id === run1.sessionId));
check("resolveSessionId('last') finds it", (await resolveSessionId("last")) === run1.sessionId);

// Resume it, deliberately passing a different target to prove scope cannot drift.
const second = scripted();
second.faux.setResponses([fauxAssistantMessage("The order route is the worst one because ...")]);

const run2 = await runAgent({
  resume: run1.sessionId,
  prompt: "which finding matters most?",
  target: "http://evil.example.test",
  model: second.model,
  streamFn: second.streamFn,
  onEvent: () => {},
  onDelta: () => {},
});

check("resumed the same session", run2.sessionId === run1.sessionId);
check("target inherited from the session, not the caller", run2.target === run1.target, run2.target);

const after = await loadSession(run1.sessionId);
check("transcript grew", after.messages.length > saved.messages.length, `${saved.messages.length} -> ${after.messages.length}`);
check("earlier messages still present", JSON.stringify(after.messages).includes("Recon done."));

const resumedCount = listSessions().then((entries) => entries.length);
check("still exactly one session", (await resumedCount) === 1);

/* --------------------- 7. model calls land in the history ------------------- */

console.log("\n7. model calls recorded in the history log");

const llmCalls = await readHistory({ kind: "llm" });
check("model calls recorded", llmCalls.length > 0, `${llmCalls.length} calls`);

const firstCall = llmCalls[0];
if (!firstCall || firstCall.kind !== "llm") {
  check("first entry is an llm call", false);
} else {
  check("call records the model", firstCall.request.model.length > 0, firstCall.request.model);
  check("call records the transcript sent", firstCall.request.messages.length > 0, `${firstCall.request.messages.length} messages`);
  check("call records the tools declared", firstCall.request.toolCount === 3, String(firstCall.request.toolCount));
  check("call records the response", Array.isArray(firstCall.response?.content));
  check("call records stop reason", typeof firstCall.response?.stopReason === "string", String(firstCall.response?.stopReason));
  check("call records a duration", (firstCall.response?.durationMs ?? -1) >= 0);
  check("call is tied to its session", typeof firstCall.sessionId === "string" && firstCall.sessionId.length > 0);
}

const everyKind = await readHistory();
check("http and llm share one log", everyKind.length > llmCalls.length, `${everyKind.length} total`);

const endpoint = await handleHistoryRequest(new Request("http://local/api/history?kind=llm"));
const body = (await endpoint?.json()) as { count: number; totals: { all: number; http: number; llm: number } } | undefined;
check("endpoint serves them", body?.count === llmCalls.length, `count=${body?.count}`);
check("endpoint reports totals", body?.totals.llm === llmCalls.length && body.totals.http > 0, JSON.stringify(body?.totals));

const filtered = await readHistory({ kind: "http" });
check("kind filter works", filtered.every((entry) => entry.kind === "http") && filtered.length > 0, `${filtered.length} http`);

/* ------------------------ 8. rolling context window ------------------------- */

console.log("\n8. rolling context window + findings always in context");
await rm(HISTORY_FILE, { force: true });
await rm(SESSION_DIR, { recursive: true, force: true });
await rm(FINDINGS, { force: true });

const KEEP = 6;
const windowed = scripted();
windowed.faux.setResponses([
  fauxAssistantMessage(
    [
      fauxToolCall("record_finding", {
        title: "Seeded finding",
        severity: "High",
        endpoint: "GET /",
        evidence: "seeded evidence",
        remediation: "seeded remediation",
      }),
    ],
    { stopReason: CURL },
  ),
  ...Array.from({ length: 10 }, () =>
    fauxAssistantMessage([fauxToolCall("run_curl", { command: `curl -i '${TARGET}/'`, reason: "loop" })], {
      stopReason: CURL,
    }),
  ),
  fauxAssistantMessage([fauxToolCall("finish_scan", { summary: "done" })], { stopReason: CURL }),
]);

const windowTrace: string[] = [];
const windowedRun = await runAgent({
  target: TARGET,
  model: windowed.model,
  streamFn: windowed.streamFn,
  findingsPath: FINDINGS,
  maxContextMessages: KEEP,
  onEvent: (line) => windowTrace.push(line),
  onDelta: () => {},
});

for (const line of windowTrace.filter((entry) => /!!|context:/.test(entry))) console.log(`  trace:${line}`);

const calls = await readHistory({ kind: "llm" });
const sentSizes = calls.map((entry) => (entry.kind === "llm" ? entry.request.messages.length : 0));
const maxSent = Math.max(...sentSizes);
check("model context stays bounded", maxSent <= KEEP + 2, `max ${maxSent} sent (keep=${KEEP})`);
check("it actually had to trim", sentSizes[0] < maxSent || maxSent >= KEEP, `${sentSizes.length} calls`);

const stored = await loadSession(windowedRun.sessionId);
check("transcript itself is not trimmed", stored.messages.length > maxSent, `${stored.messages.length} stored vs ${maxSent} sent`);

const lastCall = calls[calls.length - 1];
const lastJson = JSON.stringify(lastCall);
// `<confirmed_findings path=` only exists in the injected block — the plain tag also
// appears in the system prompt, which would make this assertion pass for free.
check("findings block injected into the request", lastJson.includes("<confirmed_findings path="));
check("injected block carries the findings file", lastJson.includes("# Findings —"));
check(
  "old turns dropped from context",
  !lastJson.includes(`Assess ${new URL(TARGET).origin} for API vulnerabilities`),
  "the opening prompt should be outside the window",
);
check("leading system prompt still present", lastJson.includes("authorized API security tester"));

await rm(FINDINGS, { force: true });
await rm(SESSION_DIR, { recursive: true, force: true });
await rm(HISTORY_FILE, { force: true });

console.log(`\n${failures === 0 ? "all checks passed" : `${failures} check(s) FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);

/**
 * Modular scan entry point.
 *
 *   bun run src/scan.ts http://127.0.0.1:5001                  # origin  -> default spec
 *   bun run src/scan.ts src/openapi.json                       # spec    -> its own server url
 *   bun run src/scan.ts src/openapi.json --url http://host:123 # spec    -> override origin
 *   bun run src/scan.ts http://host:123 --checks myrules.json  # pick a rule set
 *
 * Spec handling lives in `swagger.ts`; running the rules lives in `staticChecker.tsx`.
 * This file only wires the two together and reports.
 */

import { runStaticChecks } from "./staticChecker";
import { resolveApi } from "./swagger";
import type { ApiInput } from "./swagger";

const DEFAULT_CHECKS = "src/static_checker.json";

/* ------------------------------------------------------------------- args */

const positional: string[] = [];
const flags = new Map<string, string>();

for (let i = 0; i < process.argv.length - 2; i += 1) {
  const arg = process.argv[i + 2]!;
  if (arg === "--json" || arg === "--verbose") {
    flags.set(arg.slice(2), "true");
  } else if (arg.startsWith("--")) {
    i += 1;
    flags.set(arg.slice(2), process.argv[i + 2] ?? "");
  } else {
    positional.push(arg);
  }
}

const input = positional[0];
const originFlag = flags.get("url");
const specFlag = flags.get("swagger");
const checksFile = flags.get("checks") ?? DEFAULT_CHECKS;
const asJson = flags.get("json") === "true";
const verbose = flags.get("verbose") === "true";

if (!input && !originFlag && !specFlag) {
  console.error(`usage: bun run src/scan.ts <origin|spec.json> [--url <origin>] [--swagger <spec.json>] [--checks <rules.json>] [--json] [--verbose]

  origin      scan it using default_swagger.json
  spec.json   enumerate the surface from the spec and scan it
  --url       override the origin the checks run against
  --checks    rule file (default ${DEFAULT_CHECKS})`);
  process.exit(1);
}

/* --------------------------------------------------------------- resolve */

const inputIsOrigin = input ? /^https?:\/\//i.test(input) : false;
const apiInput: ApiInput = {
  target: originFlag ?? (inputIsOrigin ? input : undefined),
  swagger: specFlag ?? (input && !inputIsOrigin ? input : undefined),
};

const api = await resolveApi(apiInput);
const specLabel = api.source === "default" ? "default_swagger.json (no spec supplied)" : (apiInput.swagger ?? "(inline)");

if (!asJson) {
  console.log(`\nTarget    ${api.baseUrl ?? "(none — the spec had no server url)"}`);
  console.log(`Spec      ${specLabel}`);
  console.log(`API       ${api.title} v${api.version}`);
  console.log(`Surface   ${api.endpoints.length} endpoints`);
  for (const endpoint of api.endpoints) {
    const label = endpoint.summary ? `  ${endpoint.summary}` : "";
    console.log(`   ${endpoint.method.padEnd(7)} ${endpoint.examplePath.padEnd(30)}${label}`);
  }
}

/* ------------------------------------------------------------------- run */

const report = await runStaticChecks(
  checksFile,
  { url: api.baseUrl ?? undefined, spec: api.document },
  { concurrency: 16 },
);

if (asJson) {
  console.log(JSON.stringify({ api, report }, null, 2));
} else {
  console.log(`\nRules     ${checksFile} — ${report.summary.total} checks`);
  console.log(
    `Result    ${report.summary.vulnerable} hit, ${report.summary.clean} clear, ${report.summary.errored} errored ` +
      `in ${report.durationMs}ms\n`,
  );

  if (report.findings.length === 0) {
    console.log("No findings.\n");
  } else {
    console.log("Hits:");
    for (const finding of report.findings) {
      console.log(`  ${String(finding.severity).padStart(4)}/10 ${finding.severityLabel.padEnd(13)} ${finding.title}`);
      console.log(`         ${finding.request.method} ${finding.request.url} -> ${finding.response.status}`);
      if (finding.evidence) console.log(`         ${finding.evidence.replace(/\s+/g, " ").slice(0, 140)}`);
    }
    console.log("");
  }

  const errored = report.results.filter((result) => result.error);
  if (errored.length) {
    const counts = new Map<string, number>();
    for (const result of errored) counts.set(result.error!, (counts.get(result.error!) ?? 0) + 1);
    console.log("Errors:");
    for (const [message, count] of counts) console.log(`  ${count}x ${message}`);
    console.log("");
  }

  if (verbose) {
    console.log("Misses:");
    for (const result of report.results.filter((entry) => !entry.vulnerable && !entry.error)) {
      console.log(`  ${String(result.severity).padStart(4)}/10 ${result.title}`);
    }
    console.log("");
  }
}

process.exit(report.summary.vulnerable > 0 ? 2 : 0);

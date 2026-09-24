/**
 * SentinelAPI demo target — an intentionally vulnerable JSON API.
 *
 * This is the thing the scanner scans. It is NOT the app backend (that is
 * `server.tsx`). Every weakness here is deliberate, matches a documented finding,
 * and is annotated inline with the rule it is meant to trip.
 *
 *   bun run src/server.ts          ->  http://127.0.0.1:5001
 *   bun run src/scan.ts http://127.0.0.1:5001
 *
 * Its OpenAPI description lives in `src/openapi.json` and is served, unprotected,
 * at `/openapi.json` — which is itself one of the findings.
 */

const PORT = Number(process.env.PORT ?? 5001);

/* ------------------------------------------------------------------- data */

const USERS: Record<string, Record<string, unknown>> = {
  "101": {
    id: "101",
    name: "Asha Verma",
    email: "asha@example.test",
    role: "user",
    tenant: "north",
    api_key: "demo-key-asha",
    password_hash: "$2b$10$Qm9ndXNIYWx0RGVtb09ubHk",
    ssn: "123-45-6789",
    internal_notes: "flagged for churn in Q3",
  },
  "202": {
    id: "202",
    name: "Noah Iyer",
    email: "noah@example.test",
    role: "user",
    tenant: "south",
    api_key: "demo-key-noah",
    password_hash: "$2b$10$QW5vdGhlckRlbW9IYXNoVg",
    ssn: "987-65-4321",
    internal_notes: "billing dispute open",
  },
};

const ORDERS: Record<string, { id: string; owner: string; total: number; card_last4: string }> = {
  "1": { id: "1", owner: "asha", total: 4200, card_last4: "4242" },
  "2": { id: "2", owner: "noah", total: 99, card_last4: "1881" },
};

const BUILD = {
  service: "SentinelAPI Demo",
  version: "1.4.2",
  environment: "staging",
  commit: "9f2c1ab",
  build_id: "build-2026-09-24.3",
  git_sha: "9f2c1ab4e7d1c0b5a2f3",
  built_at: "2026-09-24T09:12:00Z",
};

/* ---------------------------------------------------------------- headers */

/**
 * Applied to every response, like a careless `after_request` hook.
 *
 * This single object is what trips most of the rules:
 *   - CORS allows any origin            (Access-Control-Allow-Origin: *)
 *   - CORS allows all request headers   (Access-Control-Allow-Headers: *)
 *   - CORS allows sensitive methods     (DELETE/PUT/PATCH advertised)
 *   - Server identity header exposed    (Server:)
 *   - Technology disclosure header      (X-Powered-By:)
 *   - Cookie missing HttpOnly / Secure  (Set-Cookie with neither)
 */
const VULNERABLE_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "X-Powered-By": "Express/4.18.2",
  Server: "nginx/1.18.0",
  "Set-Cookie": "session=demo-session-id-not-a-real-secret; Path=/; Max-Age=86400",
};

/** Deliberately omitted: HSTS, CSP, X-Content-Type-Options, X-Frame-Options,
 *  Referrer-Policy, Permissions-Policy, and any Cache-Control on sensitive reads. */

function send(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body, null, 2), {
    status,
    headers: {
      ...VULNERABLE_HEADERS,
      "Content-Type": typeof body === "string" ? "text/html; charset=utf-8" : "application/json",
      ...extra,
    },
  });
}

/* ---------------------------------------------------------------- routing */

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: VULNERABLE_HEADERS });

    // Low: service banner with build metadata on the root, plus a weak cookie.
    if (path === "/") {
      return send({
        service: BUILD.service,
        message: "SentinelAPI demo target",
        documentation: "/docs",
        spec: "/openapi.json",
      });
    }

    // Medium: health check naming its dependencies and versions to anonymous callers.
    if (path === "/health") {
      return send({
        status: "ok",
        environment: BUILD.environment,
        database: { driver: "postgresql", host: "db.internal", latency_ms: 4, status: "up" },
        cache: { driver: "redis", host: "redis.internal", status: "up" },
        queue: { driver: "rabbitmq", status: "degraded" },
        uptime_seconds: 918_442,
      });
    }

    // Low: version endpoint handing out commit / build / sha for free.
    if (path === "/version") return send(BUILD);

    // Low: Prometheus-style metrics exposed with internal service names.
    if (path === "/metrics") {
      return send(
        [
          "# HELP process_start_time_seconds Start time of the process",
          "process_start_time_seconds 1758705120",
          'jvm_memory_used_bytes{service="orders-api"} 4.194304e+08',
          'http_requests_total{hostname="orders-api-7f9c",status="200"} 18244',
        ].join("\n"),
        200,
        { "Content-Type": "text/plain; version=0.0.4" },
      );
    }

    // Low: the OpenAPI description is served without authentication.
    if (path === "/openapi.json") {
      return new Response(Bun.file(new URL("./openapi.json", import.meta.url)), {
        headers: { ...VULNERABLE_HEADERS, "Content-Type": "application/json" },
      });
    }

    // Low: interactive documentation UI, also unauthenticated.
    if (path === "/docs") {
      return send(
        `<!doctype html><html><head><title>SentinelAPI Demo — Swagger UI</title></head>
<body><div id="swagger-ui">Swagger UI is loading the API description...</div>
<p>OpenAPI 3.0 · swagger-ui-dist</p></body></html>`,
      );
    }

    // High: excessive data exposure — no field filtering on a profile-shaped read.
    const userMatch = path.match(/^\/api\/users\/([\w-]+)$/);
    if (userMatch) {
      const user = USERS[userMatch[1]!];
      if (!user) return send({ error: "user not found" }, 404);
      return send(user);
    }

    // Critical: BOLA — any caller can read any order, no ownership check at all.
    const orderMatch = path.match(/^\/api\/orders\/([\w-]+)$/);
    if (orderMatch) {
      const order = ORDERS[orderMatch[1]!];
      if (!order) return send({ error: "order not found" }, 404);
      return send(order);
    }

    // Critical: privileged configuration with no authentication.
    if (path === "/api/admin/config") {
      return send({
        environment: BUILD.environment,
        auth_required: false,
        signing_key: "demo-signing-key-not-for-use",
        internal_service: "http://127.0.0.1:5001/internal",
        debug: true,
      });
    }

    // Medium: unbounded page_size — the caller picks how much data comes back.
    if (path === "/api/search") {
      const size = Number(url.searchParams.get("page_size") ?? "10");
      const items = Object.values(USERS).slice(0, Math.max(size, 0));
      return send({ query: url.searchParams.get("q") ?? "", page_size: size, items });
    }

    // Medium: verbose failure — SQL fragment, stack frame and absolute path.
    if (path === "/api/debug/error") {
      return send(
        {
          error: "QueryFailedError",
          message: "SQL syntax error near 'SELECT * FROM users WHERE id = '",
          stack: "at QueryRunner.query (/srv/app/src/db/query-runner.ts:214:17)\nat processTicksAndRejections (node:internal/process/task_queues:95:5)",
          path: "/srv/app/src/db/query-runner.ts",
        },
        500,
      );
    }

    // Medium: no rate limiting on login, and the session cookie is not hardened.
    if (path === "/api/login" && request.method === "POST") {
      return send({ authenticated: true, access_token: "demo-access-token", expires_in: 3600 });
    }

    // Deliberately terse: echoing the requested path back lets content-matching
    // rules fire on the path itself rather than on anything real.
    return send({ error: "not found" }, 404);
  },
});

console.log(`SentinelAPI demo target listening on http://127.0.0.1:${server.port}`);
console.log(`  GET  /                 service banner + weak cookie`);
console.log(`  GET  /health           dependency detail          (rule: health leaks internals)`);
console.log(`  GET  /version          build metadata             (rule: version metadata exposed)`);
console.log(`  GET  /metrics          prometheus text             (rule: metrics leak internals)`);
console.log(`  GET  /openapi.json     unprotected schema          (rule: unprotected schema endpoint)`);
console.log(`  GET  /docs             unprotected Swagger UI      (rule: unprotected docs UI)`);
console.log(`  GET  /api/users/{id}   excessive data exposure`);
console.log(`  GET  /api/orders/{id}  BOLA — no owner check`);
console.log(`  GET  /api/admin/config unauthenticated privileged config`);
console.log(`  GET  /api/debug/error  verbose SQL / stack trace`);
console.log(`  POST /api/login        no rate limit, weak cookie`);

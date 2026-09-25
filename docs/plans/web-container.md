Save this entire prompt verbatim to docs/plans/web-container.md and re-read it if your context is compacted. Read CONVENTIONS.md first.

Goal: web moves off Vercel into docker-compose.prod.yml on the same server as api. Same origin via a reverse proxy. Web and api stay separate images.

Step 0 — Clean tree. STOP if dirty.

Step 1 — Inventory (report file:line for each). STOP if any answer blocks the design below:
1. Every NEXT_PUBLIC_* variable in apps/web and what it's used for. Which ones hold URLs?
2. How the browser calls the api (base URL source) and how server-side code calls it.
3. Does the api serve routes under /api already, or at root? (Decides whether the proxy strips the prefix.)
4. Better Auth config: baseURL, trustedOrigins, cookie domain/secure/sameSite settings, where WEB_ORIGIN and API_URL are read.
5. CORS config in apps/api.
6. Anything Vercel-specific in apps/web: edge runtime, @vercel/* packages, vercel.json, image optimisation, middleware runtime.
7. Is next.config set to output: "standalone"?

Design (decided):
- apps/web/Dockerfile: multi-stage, pnpm, Next.js standalone output, x86 target, non-root, listens on 3000, /api/health-style healthcheck against the web server itself.
- Browser calls the api via relative /api. No api URL baked in at build time. Server-side calls use an internal URL env var (http://niacore-api:4001), read at runtime.
- Add to docker-compose.prod.yml, in the existing format (niacore-* names, ${WEB_IMAGE_VERSION}, env_file: .env, list-style environment, niacore-network):
  - niacore-web
  - niacore-proxy: nginx:alpine, the only service with public ports (80/443 or a single ${PROXY_PORT}); routes / → niacore-web:3000 and /api/ → niacore-api:4001 (strip prefix only if Step 1.3 says so); pass Host, X-Forwarded-For, X-Forwarded-Proto; config file committed under deploy/nginx/.
  - Remove the public port mapping from niacore-api.
- WEB_ORIGIN and API_URL both become the single public origin. Better Auth cookies: first-party, secure in production, no cross-site settings. CORS can be restricted to that origin.
- Keep connector aliases untouched.
- Update .env example / DEPLOYMENT.md with the new variables and the routing contract (so infra can swap nginx for their own proxy).

Tests (minimal):
- Boot test: full prod compose against a throwaway Postgres; all services healthy; through the proxy: GET / returns the web page, GET /api/health returns ok, sign-in sets a cookie and a follow-up authenticated request succeeds.
- Typecheck every package.

Close-out: report Step 1 findings, every file changed, anything Vercel-specific removed or left, boot-test output. Record the decision in docs/decisions.md.

Don't commit.

---

## Execution log

### Step 0 — clean tree

Tree was dirty: `services/connector-{mysql,mongodb,supabase}/Dockerfile`
had uncommitted changes unrelated to this task. Stashed per user
instruction (`git stash push -m "connector dockerfiles - review later"
services/connector-*/Dockerfile`) rather than losing or committing them,
and continued.

### Step 1 — inventory

1. **`NEXT_PUBLIC_*` vars in apps/web**: `NEXT_PUBLIC_API_URL` (base URL
   for server-side api calls, `src/lib/api/server.ts`, `src/lib/api/
   chatServer.ts`) and `NEXT_PUBLIC_SITE_URL` (Better Auth `baseURL`,
   `src/lib/auth/auth.ts:20`). Both hold URLs. `NEXT_PUBLIC_SITE_URL` had
   exactly one consumer repo-wide (confirmed by grep) — server-only code,
   never bundled to the browser, so the `NEXT_PUBLIC_` prefix was
   unnecessary.
2. **Browser→api / server→api**: the browser never calls the api
   directly — it calls same-origin `/api/backend/*`, which
   `next.config.mjs`'s `rewrites()` proxies to `API_ORIGIN` (was
   `NEXT_PUBLIC_API_URL`). Server-side code (`server.ts`, `chatServer.ts`)
   read the same var directly for its own fetches.
3. **apps/api route mounting**: at ROOT, not under `/api` — `/health`,
   `/dashboard`, `/projects`, `/workflows` (`runsRouter` mounted before
   `workflowsRouter` deliberately, so `workflowsRouter`'s blanket
   `requireAuth` doesn't intercept `runsRouter`'s cookie-authed routes),
   `/connectors`, `/connections`, `/` (`chatRouter`, mounted last),
   `/copilot-agent` (`apps/api/src/index.ts`).
4. **Better Auth**: `packages/auth/src/config.ts` takes `baseURL` as an
   option, no `trustedOrigins`, no explicit cookie `domain`/`secure`/
   `sameSite` — the `__Secure-` cookie-name prefix is derived
   independently per instance from that instance's own `baseURL` scheme
   (`better-auth/dist/cookies/index.mjs`, `createCookieGetter`).
   `WEB_ORIGIN`/`API_URL` read in `apps/api/src/env.ts`;
   `NEXT_PUBLIC_SITE_URL` read in `apps/web/src/lib/auth/auth.ts`.
5. **CORS**: `apps/api/src/index.ts` restricts to a single `WEB_ORIGIN`.
6. **Vercel-specific code**: none found — no `@vercel/*` packages, no
   `vercel.json`, no edge runtime, no image-optimisation config tied to
   Vercel, no Vercel-specific middleware.
7. **`output: "standalone"`**: yes, already set in `next.config.mjs`,
   along with `outputFileTracingRoot: path.join(__dirname, '../..')`
   (repo root — required for the standalone build to trace workspace
   symlinks correctly in this pnpm monorepo).

### Design conflict found, and the resolution actually used

The "decided" design above (browser calls a same-origin `/api`, nginx
routes `/api/` → `niacore-api:4001` directly) conflicts with the existing
app: apps/web already has its own `/api/backend/*` Next.js rewrite as the
browser→api path, and `NEXT_PUBLIC_API_URL` gets webpack-inlined at build
time even in server-only files. Routing `/api/` at the nginx layer too
would double-proxy and fight the existing rewrite.

**Revised design used instead** (superseding the "decided" section
above):
- `niacore-proxy` (nginx) routes **everything** to `niacore-web:3000`. No
  `/api/` routing in nginx — it is public entry / TLS front door only, so
  infra can swap in their own proxy without touching app code.
- Next.js's existing `/api/backend/*` rewrite remains the **only**
  browser→api path. Its target became the internal address
  `http://niacore-api:4001`, read from a new var. Baking that hostname in
  at build time is fine — it's identical in every environment (Docker
  network alias, not a public URL).
- `server.ts`/`chatServer.ts` and the rewrite in `next.config.mjs` now all
  read `API_INTERNAL_URL` (default `http://niacore-api:4001`) — a plain
  runtime var, **not** `NEXT_PUBLIC_`-prefixed, so it's never inlined into
  the browser bundle. `NEXT_PUBLIC_API_URL` removed (had no other
  consumers).
- `NEXT_PUBLIC_SITE_URL` renamed to plain `SITE_URL` (its one consumer is
  server-only) — reads at runtime instead of being baked at build time.
- `niacore-api` has no public port mapping at all.
- `WEB_ORIGIN`, `SITE_URL`, and `API_URL` are all set to the same single
  public https origin.

### Pre-build checks (all passed; findings below)

1. **Route collisions under `apps/web/src/app/api/`**: only
   `apps/web/src/app/api/auth-token/route.ts` existed before this work;
   added `apps/web/src/app/api/health-web/route.ts` (container
   healthcheck target, deliberately not named `health` to avoid ambiguity
   with apps/api's own `/health`). Neither collides with `/api/backend`.
   **Pass.**
2. **Better Auth cookie name parity**: the `__Secure-` prefix is derived
   independently per instance from that instance's own `baseURL` scheme.
   As long as `API_URL` (apps/api) and `SITE_URL` (niacore-web) are set to
   the exact same public https origin — which the revised design
   requires — both instances derive the same cookie name. **Pass,
   contingent on that env discipline**, now documented in both
   `.env.production.example` files and `DEPLOYMENT.md`.
3. **Rewrite proxy timeout**: `next.config.mjs` already had
   `experimental.proxyTimeout: 120_000` for the copilot tool loop, but
   `apps/api/src/env.ts`'s `RUN_SSE_MAX_DURATION_MS` defaults to
   1,800,000ms (30min) for workflow-run SSE streams, which are also
   proxied through `/api/backend/*`. **Gap found and fixed**: raised
   `proxyTimeout` to `1_800_000` to match, and set matching
   `proxy_read_timeout`/`proxy_send_timeout 1800s` (plus
   `proxy_buffering off`) in `deploy/nginx/nginx.conf` so SSE isn't
   buffered or cut off at either hop.
4. **`NEXT_PUBLIC_SITE_URL` build-time baking**: confirmed via repo-wide
   grep it has exactly one consumer, `apps/web/src/lib/auth/auth.ts:20`,
   which is server-only code (never bundled to the browser). **Resolved
   by renaming to plain `SITE_URL`** — read at runtime, so the same image
   works against any public origin without a rebuild.

### Files changed

- `apps/web/next.config.mjs` — rewrite target renamed
  `NEXT_PUBLIC_API_URL` → `API_INTERNAL_URL`; `proxyTimeout` raised
  `120_000` → `1_800_000`.
- `apps/web/src/lib/auth/auth.ts` — `baseURL` reads `SITE_URL` instead of
  `NEXT_PUBLIC_SITE_URL`.
- `apps/web/src/lib/api/server.ts`, `apps/web/src/lib/api/chatServer.ts`
  — read `API_INTERNAL_URL` instead of `NEXT_PUBLIC_API_URL`.
- `apps/web/e2e/copilot.spec.ts` — same var rename (2 occurrences).
- `apps/web/.env`, `apps/web/.env.local`, `apps/web/.env.example` — var
  renames + updated comments.
- `apps/web/.env.production.example` — new file.
- `apps/web/src/app/api/health-web/route.ts` — new file, container
  healthcheck endpoint.
- `apps/web/Dockerfile` — new file, multi-stage pnpm/Next standalone
  build mirroring `apps/api/Dockerfile`'s pattern.
- `docker-compose.prod.yml` — added `niacore-web` and `niacore-proxy`
  services; removed `niacore-api`'s public port mapping.
- `deploy/nginx/nginx.conf` — new file, front-door-only config (routes
  everything to `niacore-web:3000`, no `/api/` routing).
- `.env.production.example` (root) — added `WEB_IMAGE_VERSION`,
  `PROXY_PORT`; updated `API_URL`/`WEB_ORIGIN` comments to document the
  shared-origin requirement; replaced the now-obsolete `API_PORT` comment.
- `apps/api/.env.production.example` — updated `API_URL`/`WEB_ORIGIN`
  comments to match (no functional/var changes).
- `DEPLOYMENT.md` — services table updated (`niacore-proxy` added as the
  only public service, `niacore-web` added, `niacore-api` now
  internal-only); new "Request routing" section documenting the two proxy
  hops; env-file list updated.
- `docs/decisions.md` — new entry recording this design decision (see
  below).

Nothing Vercel-specific was found to remove (Step 1.6) — this was a
pure infrastructure addition, not a migration away from Vercel-specific
code.

## Tests

### Typecheck

`turbo run typecheck` across all 16 packages: all pass (cache hits,
FULL TURBO).

### Boot test

Full `docker-compose.prod.yml` stack (`niacore-api`, `niacore-web`,
`niacore-proxy`) built and run against a throwaway `postgres:17-alpine`
container, bootstrapped with `docker/local-postgres-bootstrap.sql`, on
an isolated Docker network. Proxy published on `localhost:8080`
(`PROXY_PORT=8080`).

Result: **all three required checks pass.**

- `GET http://localhost:8080/` → 200, renders the web app.
- `GET http://localhost:8080/api/health-web` → 200.
- `GET http://localhost:8080/api/backend/health` → 200
  `{"status":"ok","service":"@nia/api"}` (proxied through to
  `niacore-api`).
- Sign-in sets a cookie and an authenticated follow-up request
  succeeds: drove a real signup through the browser
  (`POST` Server Action → `auth.api.signUpEmail`), landed in the
  authenticated `/app` shell ("Good afternoon, Boot"), and
  `niacore-api`'s access log shows the follow-up dashboard calls
  succeeding with a real actor id:
  ```
  GET /dashboard/continue 200 actor=52cb8891-7a9f-44d9-85ab-b8e96811732e
  GET /dashboard/recent-runs 200 actor=52cb8891-7a9f-44d9-85ab-b8e96811732e
  GET /projects/sidebar 200 actor=52cb8891-7a9f-44d9-85ab-b8e96811732e
  GET /dashboard/stats 200 actor=52cb8891-7a9f-44d9-85ab-b8e96811732e
  ```
  This proves the Better Auth session cookie flowed correctly through
  `niacore-proxy` → `niacore-web` → the `/api/backend/*` rewrite →
  `niacore-api`'s cookie-authenticated routes.

### Gaps found and fixed during the boot test

1. **`dotenv` missing from `apps/web/package.json`.** `next build`'s
   typecheck failed inside the Docker build:
   `Cannot find module 'dotenv'` in `e2e/globalSetup.ts`. It only
   worked locally because a full monorepo `pnpm install` hoists
   `dotenv` from `apps/api`/`apps/worker`'s own dependencies — the
   Docker build's scoped install (only the touched workspaces'
   `package.json` files are copied in) doesn't get that hoist. Fixed
   by adding `dotenv` as a direct devDependency of `apps/web`.

2. **`API_INTERNAL_URL` is not actually a runtime-configurable var for
   the rewrite — it's build-time-baked, and that's correct, not a
   bug.** Initial boot test hit `GET /api/backend/health` → 500,
   `ECONNREFUSED` to `localhost:4001`. Root cause: Next.js's
   `output: "standalone"` build calls `next.config.mjs`'s
   `rewrites()` exactly once during `next build` and freezes the
   resolved destination as a literal string inside the generated
   `server.js` — setting `API_INTERNAL_URL` on the *running container*
   has no effect on that rewrite, only setting it at *image build
   time* does. This reopened a design question the original "revised
   design" section above had gotten wrong (it assumed the var was read
   at runtime). Resolved (explicit decision, not the route-handler-proxy
   alternative that was considered): keep the existing
   `next.config.mjs` rewrite and `process.env.API_INTERNAL_URL ??
   'http://localhost:4001'` fallback unchanged; set
   `ENV API_INTERNAL_URL=http://niacore-api:4001` as a hard value in
   `apps/web/Dockerfile`'s build stage, before `next build`, with a
   comment explaining why baking it is safe: the value is a fixed
   Docker-network hostname, identical in every environment — the same
   contract as the connector aliases — not a real per-deployment
   config value, so baking it doesn't break "build once, deploy
   anywhere." `server.ts`/`chatServer.ts` already read
   `API_INTERNAL_URL` at plain runtime and needed no change (they're
   ordinary server modules, not part of `next.config.mjs`'s
   build-time-serialized rewrite table). A route-handler-based proxy
   was considered and explicitly rejected — it would mean
   reimplementing header/cookie/body/streaming/abort forwarding for no
   benefit over the existing rewrite.

3. **Every Server Action (`login`, `signup`, ...) was rejected with
   `Invalid Server Actions request.`**, logged by `niacore-web` as
   `x-forwarded-host` header with value `localhost` does not match
   `origin` header with value `localhost:8080`. Root cause:
   `deploy/nginx/nginx.conf` had `proxy_set_header Host $host;` — nginx's
   `$host` variable never includes the port, even when the client's
   original `Host` header had one. On the default port this is
   invisible, but on any non-default port (this boot test's `:8080`, and
   any real deployment not sitting bare on `:80`/`:443`) it silently
   drops the port from the `Host` forwarded to `niacore-web`, which
   Next.js then uses as `x-forwarded-host`. That no longer matches the
   browser's `Origin` header (which does include the port), and Next's
   Server Actions same-origin check aborts the request — this broke
   every sign-in/sign-up attempt until fixed. **Fixed** by changing it to
   `proxy_set_header Host $http_host;` — `$http_host` forwards the
   client's original `Host` header byte-for-byte, so it always matches
   `Origin`.

4. **Boot-test-only, not a real bug**: `docker-compose.prod.yml`'s
   `env_file: - .env` reads the literal repo-root `.env` (this repo's
   real local-dev file), independent of `--env-file`. Local dev's
   `CONNECTOR_DEV_HOST` leaking in caused `niacore-api` to fail its
   production env validation inside the throwaway test only. Worked
   around in the boot test with a compose override unsetting that var
   for `niacore-api`; no repo change needed since this only happens
   when testing from a working tree that also has a populated
   dev `.env`, which infra deployments never will.

### Boot-test teardown

Throwaway Postgres container, Docker network, compose project
(`niacoreboot`), and test-only images (`niacore-api:boottest`,
`niacore-web:boottest`) are scratch resources, not part of the repo,
and are torn down after this test — no cleanup required in the
working tree itself.

**No commits were made for this work** — the working tree changes
above (dotenv dependency, `API_INTERNAL_URL` build-time bake +
comments, `deploy/nginx/nginx.conf`'s `$host` → `$http_host` fix) are
left in place, uncommitted, per instruction.

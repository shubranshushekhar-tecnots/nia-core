Save this prompt verbatim to docs/plans/local-verify.md. Don't commit.

Step 0. I've replaced docker-compose.prod.yml and .env.production.example with new versions. Show `git diff --stat`, confirm both changed. Validate: `docker compose -f docker-compose.prod.yml --env-file .env.production.example config > /dev/null`. Update DEPLOYMENT.md if it disagrees with either file.

Step 1. Quick checks, report each:
a. Typecheck said 12/12 packages; earlier sessions said 16. List every workspace package and whether it has a typecheck script. Explain the difference.
b. Find where CSV/Excel upload is actually handled (apps/web route/server action, worker, or client-side). Report the real size limit on that path, including Next's serverActions.bodySizeLimit if it's a server action. Set nginx client_max_body_size to match.

Step 2. Local test rules (8 GB Mac, Docker VM ~3.8 GB): native platform builds only, one image at a time, ask me to stop the dev sandbox first, boot only what each phase needs, `docker stats --no-stream` after each boot, tear down after each phase.

Build all six images natively, one at a time: api, worker, web, connector-mysql, connector-mongodb, connector-supabase. After each connector build, run the image with `node -e` importing @nia/secrets and @nia/db.

Phase A — connectors. Throwaway Postgres (Nia's DB, also the target for connector-supabase), redis, api, connector-supabase. Create a connection whose credentials go through nia_secrets; hit /test and /introspect through the api. Tear down. Then repeat with connector-mysql against a throwaway mysql, then connector-mongodb against a throwaway mongo, one at a time.

Phase B — web. Throwaway Postgres, redis, api, web, proxy. Through the proxy: GET / is 200, sign up, sign in, cookie set, an authenticated /api/backend call works. Restart niacore-web alone and confirm the proxy still serves without restarting nginx. If LLM credentials are available, send one chat request and confirm SSE streams incrementally; if not, say so and skip.

Phase C — full stack. Generate a throwaway .env from .env.production.example (local image tags, throwaway secrets, throwaway Postgres URL). `docker compose -f docker-compose.prod.yml up -d`, all services healthy in the right order (api before web and worker, web before proxy). Report docker stats. Tear down, including throwaway volumes.

Report pass/fail per phase. If something fails, stop and report. Don't fix without telling me.

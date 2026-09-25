Save this entire prompt verbatim to docs/plans/release-prep.md and re-read it if your context is compacted. Read CONVENTIONS.md first. Don't run Docker locally — my Mac can't handle it.

Step 0 — Tree must be clean. STOP if not.

Step 1 — Inventory (file:line). STOP if anything blocks the design:
1. apps/api upload size limit for CSV/Excel uploads.
2. Current deploy/nginx/nginx.conf and the redis command in docker-compose.prod.yml.

Design (decided):

A. Redis (docker-compose.prod.yml): --maxmemory-policy allkeys-lru → noeviction. Comment: BullMQ needs noeviction, or jobs can be silently dropped.

B. nginx (deploy/nginx/nginx.conf):
- Remove the upstream block. Add `resolver 127.0.0.11 valid=10s ipv6=off;` and use `set $web http://niacore-web:3000; proxy_pass $web;` so a restarted web container doesn't cause 502s.
- Add `map $http_x_forwarded_proto $fwd_proto { default $http_x_forwarded_proto; "" $scheme; }` and send `X-Forwarded-Proto $fwd_proto` (TLS terminates at a load balancer in front).
- Set client_max_body_size to the api upload limit from Step 1.1 plus headroom (50m if there's no limit).
- KEEP `proxy_set_header Host $http_host;`, buffering off, and the 1800s timeouts.

C. GitHub Actions: .github/workflows/images.yml
- Trigger: push of a tag matching v*, plus workflow_dispatch.
- ubuntu-latest, linux/amd64, one matrix job per image.
- Permissions: contents: read, packages: write. Log in to ghcr.io with the built-in GITHUB_TOKEN only.
- Images: apps/api, apps/worker, apps/web, services/connector-mysql, services/connector-mongodb, services/connector-supabase.
- Names: ghcr.io/<repo owner, lowercased>/niacore-<service>:<tag exactly as pushed, e.g. v1.0.1>, plus :latest.
- After each connector build, run the image with `node -e` importing @nia/secrets and @nia/db; fail the job if either is missing.
- Use GitHub Actions build cache.

D. Docs: update .env.production.example and DEPLOYMENT.md so image names match (niacore-connector-supabase, not -postgres) and tags include the v. Add how to release: `git tag v1.0.1 && git push company v1.0.1`.

Tests:
- Validate nginx.conf syntax without local Docker if possible (explain how if not), and validate the workflow YAML (actionlint if available).
- Typecheck every package.

Close-out: list files changed, record A–D in docs/decisions.md.

Don't commit.

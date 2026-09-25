# One-off migration runner — never part of the running service topology,
# never referenced by docker-compose.prod.yml. Build from the repo root:
#   docker build -f supabase/migrate.Dockerfile -t nia/migrate .
# Run as a release step:
#   docker run --rm -e DATABASE_URL="$DATABASE_URL" nia/migrate status
#   docker run --rm -e DATABASE_URL="$DATABASE_URL" nia/migrate push
#   docker run --rm -e DATABASE_URL="$DATABASE_URL" nia/migrate verify
# No Supabase CLI — see scripts/migrate.mjs and docs/plans/local-dev.md for
# why (this is the last release-pipeline dependency on it, now removed).
FROM node:22-alpine
WORKDIR /workspace
RUN npm install pg@8.13.1 --no-save
COPY supabase/migrations supabase/migrations
COPY scripts/migrate.mjs scripts/migrate.mjs
ENTRYPOINT ["node", "scripts/migrate.mjs"]
CMD ["status"]

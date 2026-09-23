# One-off migration runner — never part of the running service topology,
# never referenced by docker-compose.prod.yml. Build from the repo root:
#   docker build -f supabase/migrate.Dockerfile -t nia/migrate .
# Run as a release step:
#   docker run --rm -e DATABASE_URL="$DATABASE_URL" nia/migrate status
#   docker run --rm -e DATABASE_URL="$DATABASE_URL" nia/migrate push
# ('verify' is CI-only — it needs a git checkout with history, which this
# image deliberately doesn't have. Run `pnpm run migrate:verify` directly
# in CI instead — see scripts/migrate.sh.)
FROM node:22-alpine
RUN apk add --no-cache bash
WORKDIR /workspace
COPY package.json ./
# Pinned to the version this repo is developed against (see CLAUDE.md /
# `supabase --version`) — bump deliberately, not via a floating tag.
RUN npm install supabase@2.117.0 --no-save
ENV PATH="/workspace/node_modules/.bin:${PATH}"
COPY supabase/config.toml supabase/config.toml
COPY supabase/migrations supabase/migrations
COPY scripts/migrate.sh scripts/migrate.sh
ENTRYPOINT ["bash", "scripts/migrate.sh"]
CMD ["status"]

#!/usr/bin/env bash
# Builds a self-contained Linux bundle tarball for the Nia Core Agent systemd
# service (docs/plans/planometry-integration.md §9, Option B). Run from
# anywhere; always operates from the repo root:
#   ./apps/agent/packaging/linux/build-bundle.sh
#
# Produces apps/agent/packaging/linux/dist/nia-core-agent-linux-<version>.tar.gz
# containing dist/ + node_modules (production deps only, including the
# workspace @nia/extract dep, materialized from its own dist/) — the exact
# same `pnpm --prod deploy` approach as apps/agent/Dockerfile, just
# tarred instead of layered into an image.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../../../.."

VERSION=$(node -p "require('./apps/agent/package.json').version")
OUT_DIR="apps/agent/packaging/linux/dist"
STAGE_DIR="$(mktemp -d)"
trap 'rm -rf "$STAGE_DIR"' EXIT

pnpm -r --filter @nia/extract --filter @nia/agent build
pnpm --filter=@nia/agent --prod deploy "$STAGE_DIR"

# Ship install.sh/uninstall.sh/nia-agent.service inside the tarball too, so
# it's a single self-contained download (matching the macOS zip and Windows
# installer, which both bundle their install scripts with the payload)
# instead of silently depending on files that only exist in this repo
# checkout. install.sh's own calling convention (`./install.sh <tarball>`)
# is unchanged -- after extracting, point it back at this same tarball.
PACKAGING_DIR="$(dirname "${BASH_SOURCE[0]}")"
cp "$PACKAGING_DIR/install.sh" "$PACKAGING_DIR/uninstall.sh" "$PACKAGING_DIR/nia-agent.service" "$STAGE_DIR/"

mkdir -p "$OUT_DIR"
TARBALL="$OUT_DIR/nia-core-agent-linux-$VERSION.tar.gz"
tar -czf "$TARBALL" -C "$STAGE_DIR" .
echo "built $TARBALL"

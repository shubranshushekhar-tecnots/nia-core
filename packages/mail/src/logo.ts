import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));

// Kept as packages/mail's own copy (packages/mail/assets/logo-mark.png)
// rather than reaching across into apps/web/public/ — this package must
// stay self-contained so apps/worker's Docker image (which never copies
// apps/web into its build context) can still find the asset. The web app
// keeps its own separate copy at apps/web/public/logo-mark.png for its own
// UI (Footer, nav, Logo component); the two are independent files, not
// symlinked, so updating the brand mark means updating both. One level up
// from both src/ (dev/test) and dist/ (built) is the package root, so
// "../assets/..." resolves the same from either location. Read lazily and
// cached: most callers (the "log" transport, every unit test) never
// actually need the bytes.
let cached: Buffer | null = null;

export function getLogoBuffer(): Buffer {
  if (!cached) {
    cached = readFileSync(path.join(here, "../assets/logo-mark.png"));
  }
  return cached;
}

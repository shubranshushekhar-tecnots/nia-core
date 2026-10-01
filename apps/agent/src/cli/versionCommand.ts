import { AGENT_VERSION } from "../generated/version.js";

/** `nia-agent version` / `--version` / `-v` — mandatory per every packaging target (docs/plans/planometry-integration.md Phase 3b §1). */
export function versionString(): string {
  return `nia-agent ${AGENT_VERSION} (node ${process.version}, ${process.platform}-${process.arch})`;
}

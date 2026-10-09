import type { Logger } from "../ops/logger.js";

/** Shared across every route builder — one `dir` (the agent's data dir, `NIA_AGENT_HOME`-overridable in tests) and `agentVersion`/`logger` for the few routes that need them. */
export interface LocalApiDeps {
  dir: string;
  agentVersion: string;
  logger: Logger;
}

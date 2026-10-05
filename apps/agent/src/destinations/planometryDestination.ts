import { runSync } from "../sync/runSync.js";
import type { KeyedSemaphore } from "../sync/concurrency.js";
import type { Destination, DestinationRunOptions, DestinationRunResult } from "./destination.js";

/**
 * Slice R2: the existing Planometry delivery path, unchanged, behind the
 * `Destination` interface — a pure pass-through to `runSync` with the
 * push key and table semaphore it needs supplied at construction time
 * (resolved once per `runJob` call, same as before this slice).
 */
export class PlanometryDestination implements Destination {
  constructor(
    private readonly pushKey: string,
    private readonly tableSemaphore: KeyedSemaphore,
  ) {}

  async run(options: DestinationRunOptions): Promise<DestinationRunResult> {
    return runSync({ ...options, pushKey: this.pushKey, tableSemaphore: this.tableSemaphore });
  }
}

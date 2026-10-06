import { loadConfig } from "../config/store.js";
import type { LinkConfig } from "../config/types.js";

const DEFAULT_POLL_MS = 2_000;

export interface LinkWatcherOptions {
  dir: string;
  /** Called whenever the link config changes from the previous poll — `undefined` means unpaired. */
  onChange: (link: LinkConfig | undefined) => void;
  pollMs?: number;
}

/**
 * A running agent only ever read `agent.config.json`'s `link` field once,
 * at `runAgentLoop` startup — `pair`/`unpair` (which write/clear that
 * field from a separate `nia-agent` CLI invocation) had no effect on an
 * already-running service until it was restarted. This polls the config
 * file's link field on a short interval and calls `onChange` exactly
 * once per actual pair/unpair, so the running service notices either
 * within a few seconds, no restart required.
 */
export class LinkWatcher {
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = true;
  private lastSignature: string | undefined;

  constructor(private readonly options: LinkWatcherOptions) {}

  start(): void {
    this.stopped = false;
    this.lastSignature = signatureOf(loadConfig(this.options.dir).link);
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(): void {
    if (this.stopped) return;
    const pollMs = this.options.pollMs ?? DEFAULT_POLL_MS;
    this.timer = setTimeout(() => this.poll(), pollMs);
  }

  private poll(): void {
    if (this.stopped) return;
    const link = loadConfig(this.options.dir).link;
    const signature = signatureOf(link);
    if (signature !== this.lastSignature) {
      this.lastSignature = signature;
      this.options.onChange(link);
    }
    this.schedule();
  }
}

function signatureOf(link: LinkConfig | undefined): string | undefined {
  return link ? JSON.stringify(link) : undefined;
}

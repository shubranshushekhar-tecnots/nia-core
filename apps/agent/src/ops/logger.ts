import fs from "node:fs";
import path from "node:path";

export type LogLevel = "info" | "warn" | "error";
export type LogFields = Record<string, string | number | boolean>;

export interface LoggerOptions {
  maxBytes?: number;
  /** Rotated backups kept, beyond the live file (agent.log.1 .. agent.log.N). */
  maxBackups?: number;
}

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_BACKUPS = 5;
const LOG_FILE_NAME = "agent.log";

/**
 * Rotating, append-only JSON-lines logger (Phase 2 §7: "rotating local
 * log files, never row data or secret values"). `log()`'s field values
 * are restricted to scalars by its type signature — there's no way to
 * pass a raw row array or a credential/secret object through it, so
 * avoiding sensitive content is enforced at the call site's type
 * boundary rather than by best-effort redaction of free-form text.
 */
export class Logger {
  private readonly filePath: string;
  private readonly maxBytes: number;
  private readonly maxBackups: number;
  private currentSize: number;

  constructor(dir: string, options: LoggerOptions = {}) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.filePath = path.join(dir, LOG_FILE_NAME);
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.maxBackups = options.maxBackups ?? DEFAULT_MAX_BACKUPS;
    this.currentSize = fs.existsSync(this.filePath) ? fs.statSync(this.filePath).size : 0;
  }

  info(event: string, fields?: LogFields): void {
    this.log("info", event, fields);
  }

  warn(event: string, fields?: LogFields): void {
    this.log("warn", event, fields);
  }

  error(event: string, fields?: LogFields): void {
    this.log("error", event, fields);
  }

  log(level: LogLevel, event: string, fields: LogFields = {}): void {
    const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields }) + "\n";
    const bytes = Buffer.byteLength(line);
    if (this.currentSize + bytes > this.maxBytes) this.rotate();
    fs.appendFileSync(this.filePath, line, { mode: 0o600 });
    this.currentSize += bytes;
  }

  private rotate(): void {
    const oldest = `${this.filePath}.${this.maxBackups}`;
    if (fs.existsSync(oldest)) fs.unlinkSync(oldest);
    for (let i = this.maxBackups - 1; i >= 1; i--) {
      const src = `${this.filePath}.${i}`;
      if (fs.existsSync(src)) fs.renameSync(src, `${this.filePath}.${i + 1}`);
    }
    if (fs.existsSync(this.filePath)) fs.renameSync(this.filePath, `${this.filePath}.1`);
    this.currentSize = 0;
  }
}

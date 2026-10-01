import type { ExtractType } from "../types.js";

export interface PlanometryColumn {
  name: string;
  type: ExtractType;
}

/** Thrown when the stream violates the NDJSON contract (docs/plans/planometry-integration.md "Rows") — e.g. line 1 isn't the columns header, the trailer's row count doesn't match what actually arrived, or the stream ends without a trailer or an error line. */
export class StreamProtocolError extends Error {}

export interface ConsumeOptions {
  /** Simulates the client vanishing: stop reading once this many data rows have arrived, without waiting for a trailer. */
  disconnectAfterRows?: number;
}

export interface ConsumeResult {
  columns: PlanometryColumn[];
  rows: unknown[][];
  keepAlives: number;
  /** The trailer's `rows` count on success; `null` if the stream errored, was disconnected, or (shouldn't happen) ended without one. */
  trailerRowCount: number | null;
  /** The failure line's message; `null` on success or disconnect. */
  error: string | null;
  disconnected: boolean;
}

/**
 * Buffers arbitrary chunks into complete `\n`-terminated lines, in
 * arrival order. Deliberately does not assume one chunk == one line —
 * a real transport (socket, HTTP chunked response) can split a line
 * across chunks or pack several lines into one, unlike NdjsonWriter's
 * own in-process `write` callback (always exactly one line per call).
 */
async function* toLines(chunks: AsyncIterable<string>): AsyncIterable<string> {
  let buffer = "";
  for await (const chunk of chunks) {
    buffer += chunk;
    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
      yield buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
    }
  }
  if (buffer.length > 0) yield buffer;
}

/** Adapts a real Node `Readable` (e.g. an HTTP response body or socket) into the `AsyncIterable<string>` shape `consumePlanometryStream` expects, decoding Buffer chunks as UTF-8. */
export async function* fromReadable(readable: NodeJS.ReadableStream): AsyncIterable<string> {
  for await (const chunk of readable) {
    yield typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf8");
  }
}

/**
 * The "fake Planometry client" (Phase 1 Slice 3): consumes an extract's
 * NDJSON stream exactly the way a real Planometry consumer would — line
 * 1 as the columns header, blank lines as keep-alives, JSON arrays as
 * rows, and either `{end,rows}` or `{error}` as the terminal line —
 * verifying the trailer's row count against what actually arrived.
 *
 * `disconnectAfterRows` simulates a consumer that vanishes mid-stream:
 * returning out of the `for await` loop invokes the source iterator's
 * `return()` (standard for-await-of cleanup semantics), which for a
 * generator wrapping a real Readable tears down the underlying
 * connection the same way a real dropped client would — this is what
 * exercises the producer side's "abort mid-stream" behaviour in Slice 4.
 */
export async function consumePlanometryStream(chunks: AsyncIterable<string>, options: ConsumeOptions = {}): Promise<ConsumeResult> {
  const result: ConsumeResult = { columns: [], rows: [], keepAlives: 0, trailerRowCount: null, error: null, disconnected: false };
  let sawColumns = false;

  for await (const line of toLines(chunks)) {
    if (!sawColumns) {
      const parsed = parseJsonLine(line, "expected the columns header as line 1");
      if (!isPlainObject(parsed) || !Array.isArray(parsed.columns)) {
        throw new StreamProtocolError(`expected the columns header as line 1, got: ${line}`);
      }
      result.columns = parsed.columns as PlanometryColumn[];
      sawColumns = true;
      continue;
    }

    if (line === "") {
      result.keepAlives += 1;
      continue;
    }

    const parsed = parseJsonLine(line, "expected a row array, keep-alive, or terminal line");
    if (Array.isArray(parsed)) {
      result.rows.push(parsed);
      if (options.disconnectAfterRows !== undefined && result.rows.length >= options.disconnectAfterRows) {
        result.disconnected = true;
        return result;
      }
      continue;
    }
    if (isPlainObject(parsed) && parsed.end === true) {
      const rows = parsed.rows;
      if (typeof rows !== "number") throw new StreamProtocolError(`trailer line missing a numeric "rows" count: ${line}`);
      if (rows !== result.rows.length) {
        throw new StreamProtocolError(`trailer claims ${rows} row(s) but only ${result.rows.length} were received`);
      }
      result.trailerRowCount = rows;
      return result;
    }
    if (isPlainObject(parsed) && typeof parsed.error === "string") {
      result.error = parsed.error;
      return result;
    }
    throw new StreamProtocolError(`unrecognized line in stream: ${line}`);
  }

  throw new StreamProtocolError("stream ended without a trailer or error line");
}

function parseJsonLine(line: string, context: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    throw new StreamProtocolError(`${context}, got unparseable line: ${JSON.stringify(line)}`);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

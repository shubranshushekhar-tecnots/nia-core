/**
 * docs/plans/planometry-v4-migration.md §4 "Requests and limits" / §10
 * slice A3: cuts a stream of already-formatted wire rows (from
 * planometry/formatForTarget.ts) into gzipped request-body parts bounded
 * by both the row cap and an uncompressed-JSON byte cap. Nothing is sent
 * over the network here — this only builds the parts; the real
 * `loadId`/`last`/`totalRows` lifecycle for a replace is A4's concern
 * (sync/replaceLoad.ts). The caller supplies `loadId`/`totalRows` as plain
 * values (replace-lifecycle bookkeeping lives in A4); this module decides
 * `last` itself, purely from whether any row remains after filling a part.
 */
import zlib from "node:zlib";
import type { PlanometryRow, PushMode } from "../planometry/types.js";

/** The request builder only needs "an object of already-formatted wire values" — reuses the existing wire-row shape rather than formatForTarget.ts's stricter `WireRow` alias. */
type WireRow = PlanometryRow;

export class RequestBuilderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequestBuilderError";
  }
}

/** guide §7: "Rows per request | 50,000 (fixed)" — the hard ceiling regardless of what /schema reports. */
const HARD_ROW_LIMIT = 50_000;

/** Headroom below Planometry's hard 64MB (post-decompression) ceiling (guide §7). */
const DEFAULT_BYTE_LIMIT = 56 * 1024 * 1024;

export interface BuildRequestPartsInput {
  mode: PushMode;
  rows: Iterable<WireRow> | AsyncIterable<WireRow>;
  /** `realtime` only (guide §2.3) — key-columns-only rows to remove. Omit entirely for other modes. */
  deleted?: Iterable<WireRow> | AsyncIterable<WireRow>;
  /** The raw `maxRowsPerRequest` value from `/schema`; capped at 50,000 here regardless. */
  schemaRowLimit: number;
  /** Uncompressed-JSON-bytes ceiling per part. Default 56 MB. */
  byteLimit?: number;
  /** Carried on every part of a multi-part replace load (guide §2.3). */
  loadId?: string;
  /** Included only on the part marked `last`, when provided (guide §2.3: "optional with last"). */
  totalRows?: number;
}

export interface RequestPart {
  /** Gzipped JSON body (send as-is with `Content-Encoding: gzip`). */
  body: Buffer;
  /** rows + deleted combined. */
  rowCount: number;
  /** UTF-8 byte length of the uncompressed JSON body this part gunzips to. */
  uncompressedBytes: number;
  last: boolean;
}

interface TaggedItem {
  tag: "row" | "deleted";
  value: WireRow;
  json: string;
  bytes: number;
}

async function* tagItems(tag: "row" | "deleted", source: Iterable<WireRow> | AsyncIterable<WireRow>): AsyncGenerator<TaggedItem> {
  for await (const value of source) {
    const json = JSON.stringify(value);
    yield { tag, value, json, bytes: Buffer.byteLength(json, "utf8") };
  }
}

async function* combineTagged(input: BuildRequestPartsInput): AsyncGenerator<TaggedItem> {
  yield* tagItems("row", input.rows);
  if (input.deleted) yield* tagItems("deleted", input.deleted);
}

/** One-item-lookahead wrapper: lets the builder know whether a part it just filled is the last one, without consuming the next item. */
function peekable<T>(source: AsyncIterable<T>): { peek(): Promise<IteratorResult<T>>; consume(): void } {
  const it = source[Symbol.asyncIterator]();
  let cached: IteratorResult<T> | undefined;
  return {
    async peek() {
      if (!cached) cached = await it.next();
      return cached;
    },
    consume() {
      cached = undefined;
    },
  };
}

function headerPrefix(mode: PushMode, loadId: string | undefined, last: boolean, totalRows: number | undefined): string {
  let header = `{"mode":${JSON.stringify(mode)}`;
  if (loadId !== undefined) header += `,"loadId":${JSON.stringify(loadId)}`;
  header += `,"last":${last}`;
  if (last && totalRows !== undefined) header += `,"totalRows":${totalRows}`;
  header += `,"rows":[`;
  return header;
}

async function gzipJoin(pieces: string[]): Promise<{ body: Buffer; uncompressedBytes: number }> {
  const gzip = zlib.createGzip();
  const chunks: Buffer[] = [];
  let uncompressedBytes = 0;
  gzip.on("data", (chunk: Buffer) => chunks.push(chunk));
  const ended = new Promise<void>((resolve, reject) => {
    gzip.on("end", resolve);
    gzip.on("error", reject);
  });
  for (const piece of pieces) {
    uncompressedBytes += Buffer.byteLength(piece, "utf8");
    gzip.write(piece);
  }
  gzip.end();
  await ended;
  return { body: Buffer.concat(chunks), uncompressedBytes };
}

/**
 * Cuts `input.rows`/`input.deleted` into gzipped request-body parts.
 * `rows` is exhausted before `deleted` is drawn from; `rows` + `deleted`
 * together count toward the row cap on every part. A part closes early
 * (even under the row cap) once the next item's JSON would cross the byte
 * cap; a single item alone bigger than the byte cap is always an error,
 * regardless of what else is (or isn't) already in the part.
 *
 * Streams: each part's rows are written into the gzip encoder one
 * `JSON.stringify(row)` at a time (plus separators), never assembled into
 * one big string first — peak memory for one part is therefore the part's
 * row objects (already held by the caller's source iterable) plus gzip's
 * own internal buffers, not a 56MB JS string.
 */
export async function* buildRequestParts(input: BuildRequestPartsInput): AsyncGenerator<RequestPart> {
  const rowLimit = Math.min(input.schemaRowLimit, HARD_ROW_LIMIT);
  const byteLimit = input.byteLimit ?? DEFAULT_BYTE_LIMIT;
  const includeDeleted = input.deleted !== undefined;
  const iterator = peekable(combineTagged(input));

  let globalIndex = 0;
  let producedAny = false;

  while (true) {
    const partRows: TaggedItem[] = [];
    const partDeleted: TaggedItem[] = [];
    let partCount = 0;
    let bodyBytes = 0;
    let last = false;

    for (;;) {
      const peeked = await iterator.peek();
      if (peeked.done) {
        last = true;
        break;
      }
      const item = peeked.value;

      if (item.bytes > byteLimit) {
        throw new RequestBuilderError(`row at index ${globalIndex} exceeds the byte limit on its own (never included: contents withheld)`);
      }

      if (partCount >= rowLimit) break;
      const separatorBytes = partCount === 0 ? 0 : 1; // leading "," for every item after the first in its array
      if (bodyBytes + item.bytes + separatorBytes > byteLimit) break;

      iterator.consume();
      globalIndex += 1;
      bodyBytes += item.bytes + separatorBytes;
      if (item.tag === "row") partRows.push(item);
      else partDeleted.push(item);
      partCount += 1;
    }

    if (partCount === 0 && !last) {
      // Nothing fit (shouldn't happen: the only way to stop without
      // reaching `last` is the row/byte cap, which always admits at least
      // one item since an over-limit single item already threw above).
      continue;
    }
    if (partCount === 0 && producedAny) break; // nothing left, and the previous part already carried `last: true`.

    const pieces: string[] = [
      headerPrefix(input.mode, input.loadId, last, last ? input.totalRows : undefined),
    ];
    partRows.forEach((item, i) => pieces.push(i === 0 ? item.json : `,${item.json}`));
    pieces.push("]");
    if (includeDeleted) {
      pieces.push(`,"deleted":[`);
      partDeleted.forEach((item, i) => pieces.push(i === 0 ? item.json : `,${item.json}`));
      pieces.push("]");
    }
    pieces.push("}");

    const { body, uncompressedBytes } = await gzipJoin(pieces);
    producedAny = true;
    yield { body, rowCount: partCount, uncompressedBytes, last };

    if (last) break;
  }
}

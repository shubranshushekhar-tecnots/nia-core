/**
 * Wire representation for binary/blob column values (mysql BLOB, postgres
 * bytea, mongo BSON Binary), shared by every connector service's /execute
 * (read) and /write routes.
 *
 * Bug fix (zero binary/blob coverage found during the overnight connector
 * matrix audit): mysql2 and `pg` both deserialize a BLOB/bytea column into
 * a plain Node `Buffer` — `JSON.stringify`-ing that Buffer directly (what
 * every connector's /execute route did before this fix) produces
 * `{"type":"Buffer","data":[...]}`, not a usable value. Worse, re-binding
 * that exact shape (or any other guessed encoding) as a write parameter
 * has no reliable inverse, since WriteRequest.rows carries no column-type
 * metadata (see contract.ts) for the write route to know which columns are
 * binary — a blind "this string looks like base64" heuristic would risk
 * mangling a genuinely non-binary text column.
 *
 * Fix: tag every binary value explicitly with this self-describing wrapper
 * on the way out of /execute (so it is unambiguous from a plain JSON
 * string/number/object a driver could otherwise produce), and recognize
 * only this exact shape on the way into /write, decoding back to a real
 * Buffer before binding — no destination-column-type lookup needed, since
 * mysql2/`pg`/the mongodb driver all natively accept a Buffer as a bound
 * parameter for any column.
 */
export interface WireBinaryValue {
  readonly __niaBytes: true;
  readonly base64: string;
}

export function encodeBinaryValue(value: Buffer): WireBinaryValue {
  return { __niaBytes: true, base64: value.toString("base64") };
}

export function isWireBinaryValue(value: unknown): value is WireBinaryValue {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>).__niaBytes === true &&
    typeof (value as Record<string, unknown>).base64 === "string"
  );
}

export function decodeBinaryValue(value: WireBinaryValue): Buffer {
  return Buffer.from(value.base64, "base64");
}

/** Convenience for a /write route: decode every wrapped value back to a Buffer, pass everything else through unchanged. */
export function decodeBinaryWriteValues(rows: unknown[][]): unknown[][] {
  return rows.map((row) => row.map((value) => (isWireBinaryValue(value) ? decodeBinaryValue(value) : value)));
}

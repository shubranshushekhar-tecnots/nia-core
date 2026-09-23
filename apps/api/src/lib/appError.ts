/**
 * Uniform error type for anything a route/middleware wants to surface to
 * the client with a specific status code + stable machine-readable code
 * (mirrors the shape of @nia/schemas' PermissionError, so the error
 * handler can treat both the same way).
 */
export class AppError extends Error {
  statusCode: number;
  code: string;
  details?: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

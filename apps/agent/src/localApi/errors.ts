/** Every error response body shape -- plain-word `message`, never a raw stack/driver message that might carry a password (callers classify first, e.g. `core/sqlLogin.ts`'s `classifySqlLoginError`). */
export interface ApiErrorBody {
  kind: string;
  message: string;
}

/** Thrown by a route handler to produce a specific status + `{kind, message}` body; the router's catch-all (router.ts) converts anything else (including a bare `Error`) to a generic 500 `{kind:"internal",...}` instead of leaking its message. */
export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly kind: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }

  toBody(): ApiErrorBody {
    return { kind: this.kind, message: this.message };
  }
}

export class UnauthorizedError extends ApiError {
  constructor(message = "missing or invalid token") {
    super(401, "unauthorized", message);
  }
}

export class NotFoundError extends ApiError {
  constructor(message = "not found") {
    super(404, "notFound", message);
  }
}

export class BadRequestError extends ApiError {
  constructor(message: string) {
    super(400, "badRequest", message);
  }
}

export class RateLimitedError extends ApiError {
  constructor(message = "too many attempts -- wait a moment and try again") {
    super(429, "rateLimited", message);
  }
}

/** Thrown by router.ts's Host-header check (DNS rebinding defense) -- a request whose `Host` doesn't name the actual bound 127.0.0.1/localhost address+port. */
export class ForbiddenError extends ApiError {
  constructor(message = "forbidden") {
    super(403, "forbidden", message);
  }
}

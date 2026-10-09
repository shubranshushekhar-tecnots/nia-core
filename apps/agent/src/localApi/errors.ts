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

/** `POST /ui/session`: the one-time code was missing, already used, or expired. */
export class OtcInvalidError extends ApiError {
  constructor(message = "That code has expired or already been used.") {
    super(400, "otcInvalid", message);
  }
}

/** Thrown by router.ts for `auth: "session"` routes when the `nia_ui_session` cookie is missing, unknown, or past its 12h inactivity window. */
export class SessionExpiredError extends ApiError {
  constructor(message = "Open Nia Agent again from the Start menu / Applications.") {
    super(401, "sessionExpired", message);
  }
}

/** Workflows screen (agent app): a mutating action (`POST /workflows/:id/actions`) has no "last known" fallback to return (unlike the read routes), so it surfaces this instead of a 5xx whenever there's no live link to the platform or the bridge call itself failed transiently. */
export class OfflineError extends ApiError {
  constructor(message = "not connected to the platform right now -- try again once the agent is back online") {
    super(503, "offline", message);
  }
}

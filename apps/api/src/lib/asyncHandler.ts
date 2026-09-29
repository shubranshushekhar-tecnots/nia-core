import type { NextFunction, Request, RequestHandler, Response } from "express";

/**
 * Express 4 does not forward rejected promises from async middleware/route
 * handlers to the error handler on its own — an unawaited throw becomes an
 * unhandled rejection instead of a clean 500. Every async middleware in
 * this app is wrapped with this so nothing can silently hang a request.
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>,
): RequestHandler {
  return (req, res, next) => {
    // Returning the promise (rather than firing-and-forgetting it) is what
    // lets tests `await handler(req, res, next)` and reliably observe the
    // handler's full effect on next() — Express itself never awaits a
    // middleware's return value, so this is invisible to real requests.
    return fn(req, res, next).catch(next);
  };
}

import type { NextFunction, Request, Response } from "express";
import { PermissionError } from "@nia/schemas";
import { ZodError } from "zod";
import { AppError } from "../lib/appError.js";

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({ error: { code: "NOT_FOUND", message: `No route for ${req.method} ${req.path}` } });
}

/**
 * Last middleware in the chain (4-arg signature required by Express to be
 * recognized as an error handler). Never leaks internals: unexpected
 * errors log server-side with full detail and return a generic message.
 * AppError / PermissionError / ZodError are the only error shapes allowed
 * to put their own message on the wire, since those are always ones a
 * route or middleware constructed deliberately.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({ error: { code: err.code, message: err.message, details: err.details } });
    return;
  }

  if (err instanceof PermissionError) {
    const statusCode = err.code === "NOT_AUTHENTICATED" ? 401 : 403;
    res.status(statusCode).json({ error: { code: err.code, message: err.message } });
    return;
  }

  if (err instanceof ZodError) {
    res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Request failed validation.", details: err.flatten() } });
    return;
  }

  console.error(`[api] unhandled error on ${req.method} ${req.path}:`, err);
  res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Something went wrong." } });
}

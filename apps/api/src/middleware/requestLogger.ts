import type { NextFunction, Request, Response } from "express";

/**
 * Minimal structured request log — method, path, status, duration, and the
 * actor if one was attached by the time the response finished. No request
 * bodies or headers are ever logged (credentials/tokens live there).
 */
export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const startedAt = process.hrtime.bigint();

  res.on("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    const actorId = req.actor?.userId ?? "-";
    console.log(
      `${req.method} ${req.originalUrl} ${res.statusCode} ${durationMs.toFixed(1)}ms actor=${actorId}`,
    );
  });

  next();
}

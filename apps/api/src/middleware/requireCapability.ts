import type { NextFunction, Request, Response } from "express";
import { assertCan, PermissionError, type OrgAction } from "@nia/schemas";
import { AppError } from "../lib/appError.js";

/**
 * The middle enforcement layer the architecture always specified: RLS is
 * still the real boundary (a bug here fails closed at the database, not
 * open), but routes now declare which OrgAction they require instead of
 * relying on UI-only gating with nothing underneath it. Must run after
 * attachActor so req.actor.role is set.
 *
 * assertCan()'s PermissionError codes map onto HTTP status here; nothing
 * about the capability matrix itself is touched.
 */
export function requireCapability(action: OrgAction) {
  return function requireCapabilityMiddleware(req: Request, _res: Response, next: NextFunction): void {
    if (!req.actor) {
      next(new AppError(401, "NOT_AUTHENTICATED", "attachActor must run before requireCapability."));
      return;
    }

    try {
      assertCan(req.actor.role, action);
      next();
    } catch (err) {
      if (err instanceof PermissionError) {
        const statusCode = err.code === "NOT_AUTHENTICATED" ? 401 : 403;
        next(new AppError(statusCode, err.code, err.message));
        return;
      }
      next(err);
    }
  };
}

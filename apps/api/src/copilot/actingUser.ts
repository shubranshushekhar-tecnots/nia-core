import type { Request } from "express";
import { scopeFromActor } from "../lib/workspaceScope.js";
import { AppError } from "../lib/appError.js";
import type { ActingUser } from "./types.js";

/**
 * Copilot agent (Part 1): "Route the acting user's identity through a
 * single helper (getActingUser), used by every tool handler, the
 * confirmation endpoint, and the audit log, so a later auth change
 * touches only that module." Requires requireCookieAuth + attachActor to
 * have already run (same precondition every other route in this codebase
 * has for req.supabase/req.actor).
 */
export function getActingUser(req: Request): ActingUser {
  if (!req.supabase || !req.actor) {
    throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");
  }
  return {
    userId: req.actor.userId,
    scope: scopeFromActor(req.actor),
    actor: req.actor,
  };
}

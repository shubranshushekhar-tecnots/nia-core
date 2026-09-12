import type { NextFunction, Request, Response } from "express";
import { ZodError, type ZodType } from "zod";
import { AppError } from "../lib/appError.js";

type ValidateSchemas = {
  body?: ZodType;
  query?: ZodType;
  params?: ZodType;
};

/**
 * Parses+replaces the declared request parts with the schema's output
 * (so handlers get typed, coerced, defaulted data — not raw req.body).
 * Every route added while porting Server Actions gets a real zod schema
 * here, including the three the audit found had none at all
 * (renameProject/renameWorkflow id, delete actions, updateWorkflowDefinition).
 */
export function validate(schemas: ValidateSchemas) {
  return function validateMiddleware(req: Request, _res: Response, next: NextFunction): void {
    try {
      if (schemas.body) req.body = schemas.body.parse(req.body);
      if (schemas.query) req.query = schemas.query.parse(req.query);
      if (schemas.params) req.params = schemas.params.parse(req.params);
      next();
    } catch (err) {
      if (err instanceof ZodError) {
        next(new AppError(400, "VALIDATION_ERROR", "Request failed validation.", err.flatten()));
        return;
      }
      next(err);
    }
  };
}

import type { AnyToolDefinition, ToolDefinition, ToolTier } from "./types.js";

/**
 * Copilot agent (Part 1): "One module per tool, registered like ops" —
 * mirrors packages/schemas/src/ops/registry.ts's OP_REGISTRY shape
 * exactly (a plain name -> module map, a register function, a lookup
 * function). TypeScript's ToolDefinition<TInput, TOutput> already makes a
 * missing field a compile error at each tool module's call site — this
 * runtime check is the second, independent enforcement the plan asks for
 * ("a tool missing its tier or summarizer fails typecheck"), and is what
 * the required unit test exercises directly (a hand-built object that
 * bypasses the type checker, e.g. via `as unknown as ToolDefinition`).
 */

const TOOL_TIERS: readonly ToolTier[] = ["read", "edit", "execute"];

const registry = new Map<string, AnyToolDefinition>();

export function registerTool<TInput, TOutput>(tool: ToolDefinition<TInput, TOutput>): void {
  if (!tool.name || typeof tool.name !== "string") {
    throw new Error("registerTool: tool.name is required.");
  }
  if (!TOOL_TIERS.includes(tool.tier)) {
    throw new Error(`registerTool("${tool.name}"): tier must be one of ${TOOL_TIERS.join("|")}, got ${String(tool.tier)}.`);
  }
  if (typeof tool.summarize !== "function") {
    throw new Error(`registerTool("${tool.name}"): summarize is required.`);
  }
  if (typeof tool.render !== "function") {
    throw new Error(`registerTool("${tool.name}"): render is required.`);
  }
  if (typeof tool.handler !== "function") {
    throw new Error(`registerTool("${tool.name}"): handler is required.`);
  }
  if (!tool.inputSchema || typeof tool.inputSchema.parse !== "function") {
    throw new Error(`registerTool("${tool.name}"): inputSchema (a zod schema) is required.`);
  }
  if (registry.has(tool.name)) {
    throw new Error(`registerTool("${tool.name}"): a tool with this name is already registered.`);
  }
  registry.set(tool.name, tool as unknown as AnyToolDefinition);
}

export function getTool(name: string): AnyToolDefinition | undefined {
  return registry.get(name);
}

export function listTools(): AnyToolDefinition[] {
  return Array.from(registry.values());
}

/** Test-only escape hatch — copilot/registry.test.ts clears between cases so tool registration order never leaks across tests. */
export function __clearRegistryForTests(): void {
  registry.clear();
}

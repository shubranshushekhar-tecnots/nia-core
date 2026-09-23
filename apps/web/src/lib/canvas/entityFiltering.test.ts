import { describe, it, expect } from "vitest";
import { filterEntities } from "./entityFiltering.js";

describe("filterEntities", () => {
  const entities = [
    { namespace: "public", name: "users", canRead: true, canWrite: true },
    { namespace: "auth", name: "users", canRead: true, canWrite: false },
    { namespace: "vault", name: "secrets", canRead: true, canWrite: true },
    { namespace: "nia", name: "__staging", canRead: true, canWrite: true },
    { namespace: "public", name: "reports", canRead: false, canWrite: true },
  ];

  it("hides system schemas by default", () => {
    const result = filterEntities(entities, { nodeType: "source", showSystemSchemas: false });
    expect(result.map((e) => `${e.namespace}.${e.name}`)).not.toContain("auth.users");
  });

  it("shows non-vault/nia system schemas once the toggle is on", () => {
    const result = filterEntities(entities, { nodeType: "source", showSystemSchemas: true });
    expect(result.map((e) => `${e.namespace}.${e.name}`)).toContain("auth.users");
  });

  it("never shows vault or nia, even with the toggle on", () => {
    const result = filterEntities(entities, { nodeType: "destination", showSystemSchemas: true });
    const keys = result.map((e) => `${e.namespace}.${e.name}`);
    expect(keys).not.toContain("vault.secrets");
    expect(keys).not.toContain("nia.__staging");
  });

  it("excludes tables the role can't SELECT for a source node", () => {
    const result = filterEntities(entities, { nodeType: "source", showSystemSchemas: false });
    expect(result.map((e) => `${e.namespace}.${e.name}`)).not.toContain("public.reports");
  });

  it("excludes tables the role can't INSERT into for a destination node", () => {
    const result = filterEntities(entities, { nodeType: "destination", showSystemSchemas: true });
    expect(result.map((e) => `${e.namespace}.${e.name}`)).not.toContain("auth.users");
  });

  it("treats undefined canRead/canWrite as allowed (mysql/mongo don't populate them)", () => {
    const result = filterEntities([{ namespace: "public", name: "orders" }], { nodeType: "source", showSystemSchemas: false });
    expect(result).toHaveLength(1);
  });
});

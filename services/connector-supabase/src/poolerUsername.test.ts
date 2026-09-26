import { describe, expect, it } from "vitest";
import { extractProjectRef, isSupabasePoolerHost, resolvePoolerUsername } from "./poolerUsername.js";

describe("isSupabasePoolerHost", () => {
  it("matches a real pooler hostname", () => {
    expect(isSupabasePoolerHost("aws-0-us-east-1.pooler.supabase.com")).toBe(true);
  });

  it("does not match a direct-connection hostname", () => {
    expect(isSupabasePoolerHost("db.abcdefghijkl.supabase.co")).toBe(false);
  });

  it("does not match an unrelated host", () => {
    expect(isSupabasePoolerHost("localhost")).toBe(false);
  });
});

describe("extractProjectRef", () => {
  it("returns the suffix after the first dot", () => {
    expect(extractProjectRef("postgres.abcdefghijkl")).toBe("abcdefghijkl");
  });

  it("returns undefined for an unqualified username", () => {
    expect(extractProjectRef("nia_write_fedee56a")).toBeUndefined();
  });
});

describe("resolvePoolerUsername", () => {
  it("appends the project ref on a pooler host with a bare username", () => {
    expect(resolvePoolerUsername("nia_write_fedee56a", "aws-0-us-east-1.pooler.supabase.com", "abcdefghijkl")).toBe(
      "nia_write_fedee56a.abcdefghijkl",
    );
  });

  it("leaves an already-qualified username unchanged on a pooler host", () => {
    expect(resolvePoolerUsername("postgres.abcdefghijkl", "aws-0-us-east-1.pooler.supabase.com", undefined)).toBe(
      "postgres.abcdefghijkl",
    );
  });

  it("leaves the username unchanged on a non-pooler host", () => {
    expect(resolvePoolerUsername("nia_write_fedee56a", "db.abcdefghijkl.supabase.co", undefined)).toBe(
      "nia_write_fedee56a",
    );
  });

  it("throws a clear error on a pooler host when no project ref is available", () => {
    expect(() => resolvePoolerUsername("nia_write_fedee56a", "aws-0-us-east-1.pooler.supabase.com", undefined)).toThrow(
      /project ref/i,
    );
  });
});

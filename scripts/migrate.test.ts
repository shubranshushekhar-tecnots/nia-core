import { describe, expect, it } from "vitest";
import { assertDirectConnection, findDrift } from "./migrate.mjs";

describe("assertDirectConnection", () => {
  it("rejects a transaction-pooler port", () => {
    expect(() => assertDirectConnection("postgres://user:pass@db.example.com:6543/postgres")).toThrow(
      /transaction-pooler/,
    );
  });

  it("rejects a hostname containing 'pooler'", () => {
    expect(() => assertDirectConnection("postgres://user:pass@aws-0-pooler.example.com:5432/postgres")).toThrow(
      /transaction-pooler/,
    );
  });

  it("allows a direct session connection", () => {
    expect(() => assertDirectConnection("postgres://user:pass@db.example.com:5432/postgres")).not.toThrow();
  });

  it("allows a direct connection with no explicit port", () => {
    expect(() => assertDirectConnection("postgres://user:pass@localhost/postgres")).not.toThrow();
  });
});

describe("findDrift", () => {
  const migrations = [
    { version: "0001", name: "0001_init.sql", sql: "select 1", checksum: "aaa" },
    { version: "0002", name: "0002_next.sql", sql: "select 2", checksum: "bbb" },
  ];

  it("returns no drift when checksums match", () => {
    const applied = new Map([
      ["0001", { checksum: "aaa" }],
      ["0002", { checksum: "bbb" }],
    ]);
    expect(findDrift(migrations, applied)).toEqual([]);
  });

  it("flags a migration whose applied checksum no longer matches its file", () => {
    const applied = new Map([
      ["0001", { checksum: "aaa" }],
      ["0002", { checksum: "changed" }],
    ]);
    expect(findDrift(migrations, applied)).toEqual(["0002_next.sql"]);
  });

  it("ignores migrations that haven't been applied yet", () => {
    const applied = new Map([["0001", { checksum: "aaa" }]]);
    expect(findDrift(migrations, applied)).toEqual([]);
  });
});

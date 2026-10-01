import fs from "node:fs";
import { buildReadonlySetupScript } from "./sqlReadonlyScript.js";

export interface RunSqlReadonlyInput {
  login?: string;
  databases?: string;
  out?: string;
}

/** `nia-agent sql readonly --login <name> --databases db1,db2 [--out <file>]`. Never accepts a password — the generated script always carries a placeholder. */
export function runSqlReadonly(input: RunSqlReadonlyInput): string {
  if (!input.login || !input.databases) {
    throw new Error("usage: nia-agent sql readonly --login <name> --databases db1,db2,db3 [--out <file>]");
  }
  const databases = input.databases
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean);
  const script = buildReadonlySetupScript({ loginName: input.login, databases });
  if (input.out) fs.writeFileSync(input.out, script, "utf8");
  return script;
}

import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { defaultHomeDir, secretsFilePath } from "../config/paths.js";
import { decrypt, encrypt, type EncryptedBlob } from "./crypto.js";

const CURRENT_KEY_VERSION = 1;

type SecretFile = Record<string, EncryptedBlob>;

/**
 * Local file-backed secret store: SQL Server credentials and Planometry
 * agent keys, encrypted with the keyfile's master key (crypto.ts), referenced
 * from agent.config.json by opaque UUID (`credentialRef`/`agentKeyRef`) —
 * config.ts never inlines a secret value.
 */
export class LocalSecretStore {
  constructor(
    private readonly masterKey: Buffer,
    private readonly dir = defaultHomeDir(),
  ) {}

  put(secret: unknown): string {
    const file = this.readFile();
    const ref = randomUUID();
    file[ref] = encrypt(this.masterKey, CURRENT_KEY_VERSION, secret);
    this.writeFile(file);
    return ref;
  }

  get<T = unknown>(ref: string): T | null {
    const blob = this.readFile()[ref];
    if (!blob) return null;
    return decrypt<T>(this.masterKey, blob);
  }

  delete(ref: string): void {
    const file = this.readFile();
    delete file[ref];
    this.writeFile(file);
  }

  private readFile(): SecretFile {
    const file = secretsFilePath(this.dir);
    if (!fs.existsSync(file)) return {};
    return JSON.parse(fs.readFileSync(file, "utf8")) as SecretFile;
  }

  private writeFile(contents: SecretFile): void {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(secretsFilePath(this.dir), JSON.stringify(contents, null, 2), { mode: 0o600 });
  }
}

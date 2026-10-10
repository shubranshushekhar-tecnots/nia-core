import { LogMailTransport } from "./transports/log.js";
import { SmtpMailTransport } from "./transports/smtp.js";
import { GraphMailTransport } from "./transports/graph.js";
import { getLogoBuffer } from "./logo.js";
import { renderTemplate, type TemplatePayload } from "./templates/index.js";
import type { MailTransport } from "./transport.js";

export type { MailTransport, MailMessage, MailAttachment } from "./transport.js";
export type { TemplatePayload, RenderedTemplate } from "./templates/index.js";
export * from "./templates/index.js";

export type MailTransportKind = "smtp" | "graph" | "log";

export interface MailEnv {
  MAIL_TRANSPORT?: string;
  MAIL_FROM_NAME?: string;
  SMTP_HOST?: string;
  SMTP_PORT?: string | number;
  SMTP_SECURE?: string;
  SMTP_USER?: string;
  SMTP_PASS?: string;
  SMTP_FROM?: string;
  MS_GRAPH_TENANT_ID?: string;
  MS_GRAPH_CLIENT_ID?: string;
  MS_GRAPH_CLIENT_SECRET?: string;
  MS_GRAPH_SENDER?: string;
}

let cached: MailTransport | null = null;
let cachedKind: MailTransportKind | null = null;

/**
 * Builds (and caches) the transport selected by MAIL_TRANSPORT. Reads
 * straight from `process.env` by default — callers that already have a
 * validated env object (apps/api/apps/worker's Zod-parsed `env`) can pass it
 * in instead, which is what both of those apps do.
 */
export function getMailTransport(env: MailEnv = process.env as MailEnv): MailTransport {
  const kind = (env.MAIL_TRANSPORT || "log") as MailTransportKind;
  if (cached && cachedKind === kind) return cached;

  if (kind === "smtp") {
    cached = new SmtpMailTransport({
      host: required(env.SMTP_HOST, "SMTP_HOST"),
      port: Number(env.SMTP_PORT || 587),
      secure: env.SMTP_SECURE === "true",
      user: required(env.SMTP_USER, "SMTP_USER"),
      pass: required(env.SMTP_PASS, "SMTP_PASS"),
      from: formatFrom(required(env.SMTP_FROM, "SMTP_FROM"), env.MAIL_FROM_NAME),
    });
  } else if (kind === "graph") {
    cached = new GraphMailTransport({
      tenantId: required(env.MS_GRAPH_TENANT_ID, "MS_GRAPH_TENANT_ID"),
      clientId: required(env.MS_GRAPH_CLIENT_ID, "MS_GRAPH_CLIENT_ID"),
      clientSecret: required(env.MS_GRAPH_CLIENT_SECRET, "MS_GRAPH_CLIENT_SECRET"),
      sender: required(env.MS_GRAPH_SENDER, "MS_GRAPH_SENDER"),
    });
  } else {
    cached = new LogMailTransport();
  }
  cachedKind = kind;
  return cached;
}

/** Test-only: forces the next getMailTransport() call to rebuild. */
export function resetMailTransportCache(): void {
  cached = null;
  cachedKind = null;
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function formatFrom(address: string, name?: string): string {
  return name ? `${name} <${address}>` : address;
}

/**
 * Renders `payload` and sends it through whichever transport is configured,
 * attaching the brand logo under `cid:logo` (every template's layout
 * references it the same way).
 */
export async function sendTemplatedMail(
  to: string,
  payload: TemplatePayload,
  env?: MailEnv,
): Promise<void> {
  const { subject, html, text } = renderTemplate(payload);
  const transport = env ? getMailTransport(env) : getMailTransport();
  await transport.send({
    to,
    subject,
    html,
    text,
    attachments: [
      { filename: "logo.png", content: getLogoBuffer(), cid: "logo", contentType: "image/png" },
    ],
  });
}

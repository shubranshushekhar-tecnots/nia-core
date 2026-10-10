import { ConfidentialClientApplication } from "@azure/msal-node";
import type { MailMessage, MailTransport } from "../transport.js";

export interface GraphTransportConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  /** Mailbox the app sends as, e.g. "notifications@yourdomain.com". */
  sender: string;
}

/**
 * Sends via Microsoft Graph's `sendMail` using app-only (client credentials)
 * auth — no delegated/user sign-in, no basic-auth SMTP (which Microsoft is
 * disabling for M365 in late 2026). Only `@azure/msal-node` is used for the
 * token; the actual Graph call is a plain `fetch`, no Graph SDK dependency.
 */
export class GraphMailTransport implements MailTransport {
  private readonly msal: ConfidentialClientApplication;
  private readonly sender: string;

  constructor(config: GraphTransportConfig) {
    this.sender = config.sender;
    this.msal = new ConfidentialClientApplication({
      auth: {
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        authority: `https://login.microsoftonline.com/${config.tenantId}`,
      },
    });
  }

  private async getAccessToken(): Promise<string> {
    const result = await this.msal.acquireTokenByClientCredential({
      scopes: ["https://graph.microsoft.com/.default"],
    });
    if (!result?.accessToken) {
      throw new Error("Microsoft Graph: failed to acquire access token");
    }
    return result.accessToken;
  }

  async send(message: MailMessage): Promise<void> {
    const token = await this.getAccessToken();
    const res = await fetch(
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(this.sender)}/sendMail`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: {
            subject: message.subject,
            body: { contentType: "HTML", content: message.html },
            toRecipients: [{ emailAddress: { address: message.to } }],
            attachments: message.attachments?.map((a) => ({
              "@odata.type": "#microsoft.graph.fileAttachment",
              name: a.filename,
              contentType: a.contentType ?? "application/octet-stream",
              contentBytes: a.content.toString("base64"),
              contentId: a.cid,
              isInline: true,
            })),
          },
          saveToSentItems: false,
        }),
      },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Microsoft Graph sendMail failed (${res.status}): ${body}`);
    }
  }
}

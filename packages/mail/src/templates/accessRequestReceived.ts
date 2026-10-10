import { renderLayout } from "./layout.js";

// Phase 3 placeholder — not wired to anything yet. Kept in the same shape
// as the Phase 1/2 templates so Phase 3 can reuse the mail service as-is.
export interface AccessRequestReceivedData {
  requesterEmail: string;
}

export function renderAccessRequestReceived({ requesterEmail }: AccessRequestReceivedData) {
  const subject = "We received your access request";
  const html = renderLayout({
    preheader: "Your access request was received",
    bodyHtml: `<p>Thanks — we received an access request for ${requesterEmail}. We'll email you once it's reviewed.</p>`,
    bodyText: "",
  });
  const text = `We received an access request for ${requesterEmail}. We'll email you once it's reviewed.`;
  return { subject, html, text };
}

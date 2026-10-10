import { renderLayout } from "./layout.js";

// Phase 3 placeholder — not wired to anything yet.
export interface AccessRequestRejectedData {
  reasonText?: string;
}

export function renderAccessRequestRejected({ reasonText }: AccessRequestRejectedData) {
  const subject = "Your Nia Core access request";
  const html = renderLayout({
    preheader: "An update on your access request",
    bodyHtml: `
      <p>We weren't able to approve your access request.</p>
      ${reasonText ? `<p>${reasonText}</p>` : ""}
    `,
    bodyText: "",
  });
  const text = `We weren't able to approve your access request.${reasonText ? ` ${reasonText}` : ""}`;
  return { subject, html, text };
}

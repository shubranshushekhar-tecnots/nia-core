import { renderButton, renderLayout } from "./layout.js";

// Phase 3 placeholder — not wired to anything yet.
export interface InviteData {
  inviterName: string;
  orgName: string;
  acceptUrl: string;
}

export function renderInvite({ inviterName, orgName, acceptUrl }: InviteData) {
  const subject = `${inviterName} invited you to ${orgName} on Nia Core`;
  const html = renderLayout({
    preheader: `Join ${orgName} on Nia Core`,
    bodyHtml: `
      <p>${inviterName} invited you to join <strong>${orgName}</strong> on Nia Core.</p>
      ${renderButton("Accept invite", acceptUrl)}
    `,
    bodyText: "",
  });
  const text = `${inviterName} invited you to join ${orgName} on Nia Core: ${acceptUrl}`;
  return { subject, html, text };
}

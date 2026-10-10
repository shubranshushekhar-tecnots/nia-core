import { renderButton, renderLayout } from "./layout.js";

// Email Phase 3 — staff-initiated direct platform invite (distinct from the
// org-scoped `invite`/InviteData template above, which stays unwired/reserved).
export interface PlatformInviteData {
  name: string | null;
  acceptUrl: string;
}

export function renderPlatformInvite({ name, acceptUrl }: PlatformInviteData) {
  const greeting = name ? `Hi ${name},` : "Hi,";
  const subject = "You're invited to Nia Core";
  const html = renderLayout({
    preheader: "You've been invited to join Nia Core",
    bodyHtml: `
      <p>${greeting}</p>
      <p>You've been invited to create an account on Nia Core.</p>
      ${renderButton("Accept invite", acceptUrl)}
    `,
    bodyText: "",
  });
  const text = `${greeting} You've been invited to create an account on Nia Core: ${acceptUrl}`;
  return { subject, html, text };
}

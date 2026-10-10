import { renderButton, renderLayout } from "./layout.js";

// Phase 3 placeholder — not wired to anything yet.
export interface AccessRequestApprovedData {
  signInUrl: string;
}

export function renderAccessRequestApproved({ signInUrl }: AccessRequestApprovedData) {
  const subject = "Your Nia Core access request was approved";
  const html = renderLayout({
    preheader: "You're approved — sign in to get started",
    bodyHtml: `
      <p>Your access request was approved. You can sign in now:</p>
      ${renderButton("Sign in", signInUrl)}
    `,
    bodyText: "",
  });
  const text = `Your access request was approved. Sign in here: ${signInUrl}`;
  return { subject, html, text };
}

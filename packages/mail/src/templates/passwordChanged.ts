import { renderLayout } from "./layout.js";

export interface PasswordChangedData {
  /** When the change happened, already formatted for display. */
  whenText: string;
}

export function renderPasswordChanged({ whenText }: PasswordChangedData) {
  const subject = "Your Nia Core password was changed";
  const html = renderLayout({
    preheader: "Your password was just changed",
    bodyHtml: `
      <p>Your Nia Core password was changed on ${whenText}.</p>
      <p>All other sessions have been signed out. If this wasn't you, reset your password immediately and contact support.</p>
    `,
    bodyText: "",
  });
  const text = `Your Nia Core password was changed on ${whenText}. All other sessions have been signed out. If this wasn't you, reset your password immediately.`;
  return { subject, html, text };
}

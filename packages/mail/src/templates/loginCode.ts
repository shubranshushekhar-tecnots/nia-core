import { renderCode, renderLayout } from "./layout.js";

export interface LoginCodeData {
  code: string;
  expiresInMinutes: number;
}

export function renderLoginCode({ code, expiresInMinutes }: LoginCodeData) {
  const subject = `${code} is your Nia Core sign-in code`;
  const html = renderLayout({
    preheader: `Your sign-in code: ${code}`,
    bodyHtml: `
      <p>Use this code to sign in to Nia Core:</p>
      ${renderCode(code)}
      <p>This code expires in ${expiresInMinutes} minutes and can only be used once. If you didn't request it, you can ignore this email.</p>
    `,
    bodyText: "",
  });
  const text = `Your Nia Core sign-in code is ${code}. It expires in ${expiresInMinutes} minutes and can only be used once.`;
  return { subject, html, text };
}

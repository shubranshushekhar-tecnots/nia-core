import { renderCode, renderLayout } from "./layout.js";

export interface VerifyEmailData {
  code: string;
  expiresInMinutes: number;
}

export function renderVerifyEmail({ code, expiresInMinutes }: VerifyEmailData) {
  const subject = `${code} is your Nia Core verification code`;
  const html = renderLayout({
    preheader: `Verify your email: ${code}`,
    bodyHtml: `
      <p>Enter this code to verify your email address:</p>
      ${renderCode(code)}
      <p>This code expires in ${expiresInMinutes} minutes. You can keep using Nia Core without verifying, but verifying helps secure your account.</p>
    `,
    bodyText: "",
  });
  const text = `Your Nia Core email verification code is ${code}. It expires in ${expiresInMinutes} minutes.`;
  return { subject, html, text };
}

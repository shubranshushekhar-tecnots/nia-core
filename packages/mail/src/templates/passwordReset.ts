import { renderButton, renderCode, renderLayout } from "./layout.js";

export interface PasswordResetData {
  code: string;
  expiresInMinutes: number;
  /** Deep link into the app's own /reset-password page, pre-filled with email+otp. */
  resetUrl: string;
}

export function renderPasswordReset({ code, expiresInMinutes, resetUrl }: PasswordResetData) {
  const subject = `${code} is your Nia Core password reset code`;
  const html = renderLayout({
    preheader: `Reset your password: ${code}`,
    bodyHtml: `
      <p>Use this code to reset your Nia Core password:</p>
      ${renderCode(code)}
      <p>Or just click the button below — it'll fill the code in for you:</p>
      ${renderButton("Reset password", resetUrl)}
      <p>This code expires in ${expiresInMinutes} minutes and can only be used once. If you didn't request a password reset, you can ignore this email.</p>
    `,
    bodyText: "",
  });
  const text = `Your Nia Core password reset code is ${code}. It expires in ${expiresInMinutes} minutes. Reset here: ${resetUrl}`;
  return { subject, html, text };
}

import { renderLayout, escapeHtml } from "./layout.js";

/**
 * Internal notification sent to CONTACT_TO_EMAIL when the landing page's
 * "Talk to us" form (apps/web/src/components/landing/ContactTab.tsx, via
 * apps/web/src/app/api/contact/route.ts) is submitted. Reply-To on the
 * enqueued job is set to the submitter's own email, so replying from the
 * inbox goes straight back to them.
 */
export interface ContactFormData {
  topic: string;
  name?: string;
  email: string;
  message: string;
}

export function renderContactForm({ topic, name, email, message }: ContactFormData) {
  const subject = `New contact form submission (${topic})`;
  const html = renderLayout({
    preheader: `New ${topic} message from ${email}`,
    bodyHtml: `
      <p><strong>Topic:</strong> ${escapeHtml(topic)}</p>
      <p><strong>Name:</strong> ${escapeHtml(name || "(not provided)")}</p>
      <p><strong>Email:</strong> ${escapeHtml(email)}</p>
      <p><strong>Message:</strong></p>
      <p style="white-space:pre-wrap;">${escapeHtml(message)}</p>
    `,
    bodyText: "",
  });
  const text = `Topic: ${topic}\nName: ${name || "(not provided)"}\nEmail: ${email}\n\n${message}`;
  return { subject, html, text };
}

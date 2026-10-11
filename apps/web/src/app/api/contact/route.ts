import { NextResponse, type NextRequest } from "next/server";
import { enqueueEmail } from "@/lib/mail/mailQueue";
import { isAuthActionRateLimited } from "@/lib/auth/rateLimit";

type ContactTopic = "question" | "feedback" | "sales";
const TOPICS: ContactTopic[] = ["question", "feedback", "sales"];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Same per-email + per-IP (4x) windowed limit used by the auth OTP actions
// (src/lib/auth/rateLimit.ts) — 5 submissions per 15-minute window is
// generous for a legitimate visitor but caps abuse of the mail queue.
const RATE_LIMIT = 5;

/**
 * Landing-page "Talk to us" endpoint (components/landing/ContactTab.tsx).
 * Enqueues a notification email to CONTACT_TO_EMAIL via the same mail
 * queue the rest of the app uses, with Reply-To set to the submitter so a
 * reply from the inbox goes straight back to them.
 */
export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (typeof body !== "object" || body === null) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  const { topic, name, email, message } = body as Record<string, unknown>;

  if (typeof topic !== "string" || !TOPICS.includes(topic as ContactTopic)) {
    return NextResponse.json({ error: "Invalid topic" }, { status: 400 });
  }
  if (typeof email !== "string" || !EMAIL_RE.test(email.trim())) {
    return NextResponse.json({ error: "A valid email is required" }, { status: 400 });
  }
  if (typeof message !== "string" || message.trim().length === 0) {
    return NextResponse.json({ error: "A message is required" }, { status: 400 });
  }
  if (name !== undefined && typeof name !== "string") {
    return NextResponse.json({ error: "Invalid name" }, { status: 400 });
  }

  const trimmedEmail = email.trim();
  const trimmedName = (name as string | undefined)?.trim() || undefined;
  const trimmedMessage = message.trim();

  if (await isAuthActionRateLimited("contact", trimmedEmail, RATE_LIMIT)) {
    // Generic success, same no-enumeration contract as the other public
    // forms (src/lib/accessRequests/actions.ts) — a rate-limited response
    // must never be distinguishable from a normal one.
    return NextResponse.json({ ok: true });
  }

  await enqueueEmail({
    kind: "send_email",
    to: process.env.CONTACT_TO_EMAIL || "support@tecnots.com",
    replyTo: trimmedEmail,
    payload: {
      template: "contactForm",
      data: { topic, name: trimmedName, email: trimmedEmail, message: trimmedMessage },
    },
  });

  return NextResponse.json({ ok: true });
}

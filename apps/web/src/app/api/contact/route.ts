import { NextResponse, type NextRequest } from "next/server";

type ContactTopic = "question" | "feedback" | "sales";
const TOPICS: ContactTopic[] = ["question", "feedback", "sales"];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Minimal landing-page "Talk to us" endpoint (components/landing/ContactTab.tsx).
 * No contact-messages table exists yet, so this just validates and logs the
 * submission server-side — swap the console.log below for a real sink (DB
 * insert, email, Slack webhook, etc.) once one exists.
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

  console.log("[contact] submission received", {
    topic,
    name: (name as string | undefined)?.trim() || undefined,
    email: email.trim(),
    message: message.trim(),
  });

  return NextResponse.json({ ok: true });
}

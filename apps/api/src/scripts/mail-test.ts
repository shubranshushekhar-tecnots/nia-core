import { getMailTransport } from "@nia/mail";
import { env } from "../env.js";

/**
 * Synchronous transport connectivity check — bypasses the BullMQ queue
 * entirely (unlike the real send_email job apps/worker consumes) so an
 * operator gets a pass/fail in the terminal immediately, without needing
 * apps/worker running. Sends a minimal built-in message, not one of the
 * branded templates in @nia/mail/templates — this only proves the
 * configured transport (MAIL_TRANSPORT) can actually deliver, nothing about
 * the auth-email wiring.
 *
 *   pnpm --filter @nia/api mail:test <to>
 */
async function main() {
  const [to] = process.argv.slice(2);
  if (!to) {
    console.error("usage: pnpm --filter @nia/api mail:test <to>");
    process.exit(1);
  }

  console.log(`sending test email via MAIL_TRANSPORT=${env.MAIL_TRANSPORT} to ${to}...`);

  const transport = getMailTransport(env);
  await transport.send({
    to,
    subject: "Nia Core — mail transport test",
    html: "<p>This is a test email from <code>pnpm --filter @nia/api mail:test</code>.</p>",
    text: "This is a test email from `pnpm --filter @nia/api mail:test`.",
  });

  console.log("sent.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

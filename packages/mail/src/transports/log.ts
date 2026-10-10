import type { MailMessage, MailTransport } from "../transport.js";

/**
 * Dev-default transport. Sends nothing — just confirms an email *would*
 * have gone out. Deliberately logs only `to`/`subject`: never the body
 * (templates can embed OTP codes/links) and never any credentials.
 */
export class LogMailTransport implements MailTransport {
  async send(message: MailMessage): Promise<void> {
    console.info(`[mail:log] would send "${message.subject}" to ${message.to}`);
  }
}

/**
 * Every mail transport (smtp/graph/log) implements this one shape. Callers
 * (apps/worker's send_email job handler, apps/api's mail:test script) only
 * ever depend on this interface, never on a concrete transport directly.
 */
export interface MailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Inline attachments, e.g. the brand logo referenced as `cid:logo` in `html`. */
  attachments?: MailAttachment[];
}

export interface MailAttachment {
  filename: string;
  content: Buffer;
  /** Content-ID referenced by `html` as `cid:<cid>`. */
  cid: string;
  contentType?: string;
}

export interface MailTransport {
  send(message: MailMessage): Promise<void>;
}

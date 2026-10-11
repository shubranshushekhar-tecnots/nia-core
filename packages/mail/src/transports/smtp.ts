import nodemailer, { type Transporter } from "nodemailer";
import type { MailMessage, MailTransport } from "../transport.js";

export interface SmtpTransportConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
}

export class SmtpMailTransport implements MailTransport {
  private readonly transporter: Transporter;
  private readonly from: string;

  constructor(config: SmtpTransportConfig) {
    this.from = config.from;
    // secure:true -> implicit TLS (typically port 465). secure:false ->
    // nodemailer negotiates STARTTLS on its own when the server offers it
    // (the standard case for port 587), matching the SMTP_SECURE=false
    // default documented in .env.example.
    this.transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: { user: config.user, pass: config.pass },
    });
  }

  async send(message: MailMessage): Promise<void> {
    await this.transporter.sendMail({
      from: this.from,
      to: message.to,
      replyTo: message.replyTo,
      subject: message.subject,
      html: message.html,
      text: message.text,
      attachments: message.attachments?.map((a) => ({
        filename: a.filename,
        content: a.content,
        cid: a.cid,
        contentType: a.contentType,
      })),
    });
  }
}

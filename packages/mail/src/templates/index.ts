import { renderLoginCode, type LoginCodeData } from "./loginCode.js";
import { renderVerifyEmail, type VerifyEmailData } from "./verifyEmail.js";
import { renderPasswordReset, type PasswordResetData } from "./passwordReset.js";
import { renderPasswordChanged, type PasswordChangedData } from "./passwordChanged.js";
import {
  renderAccessRequestReceived,
  type AccessRequestReceivedData,
} from "./accessRequestReceived.js";
import {
  renderAccessRequestApproved,
  type AccessRequestApprovedData,
} from "./accessRequestApproved.js";
import {
  renderAccessRequestRejected,
  type AccessRequestRejectedData,
} from "./accessRequestRejected.js";
import { renderInvite, type InviteData } from "./invite.js";
import { renderPlatformInvite, type PlatformInviteData } from "./platformInvite.js";
import { renderContactForm, type ContactFormData } from "./contactForm.js";

export type {
  LoginCodeData,
  VerifyEmailData,
  PasswordResetData,
  PasswordChangedData,
  AccessRequestReceivedData,
  AccessRequestApprovedData,
  AccessRequestRejectedData,
  InviteData,
  PlatformInviteData,
  ContactFormData,
};

/**
 * Discriminated union of every template this service knows how to render.
 * `packages/schemas/src/jobs.ts`'s `SendEmailJob` mirrors this exact shape
 * (`template` + `data`) so a job payload maps 1:1 onto a render call.
 */
export type TemplatePayload =
  | { template: "loginCode"; data: LoginCodeData }
  | { template: "verifyEmail"; data: VerifyEmailData }
  | { template: "passwordReset"; data: PasswordResetData }
  | { template: "passwordChanged"; data: PasswordChangedData }
  | { template: "accessRequestReceived"; data: AccessRequestReceivedData }
  | { template: "accessRequestApproved"; data: AccessRequestApprovedData }
  | { template: "accessRequestRejected"; data: AccessRequestRejectedData }
  | { template: "invite"; data: InviteData }
  | { template: "platformInvite"; data: PlatformInviteData }
  | { template: "contactForm"; data: ContactFormData };

export interface RenderedTemplate {
  subject: string;
  html: string;
  text: string;
}

export function renderTemplate(payload: TemplatePayload): RenderedTemplate {
  switch (payload.template) {
    case "loginCode":
      return renderLoginCode(payload.data);
    case "verifyEmail":
      return renderVerifyEmail(payload.data);
    case "passwordReset":
      return renderPasswordReset(payload.data);
    case "passwordChanged":
      return renderPasswordChanged(payload.data);
    case "accessRequestReceived":
      return renderAccessRequestReceived(payload.data);
    case "accessRequestApproved":
      return renderAccessRequestApproved(payload.data);
    case "accessRequestRejected":
      return renderAccessRequestRejected(payload.data);
    case "invite":
      return renderInvite(payload.data);
    case "platformInvite":
      return renderPlatformInvite(payload.data);
    case "contactForm":
      return renderContactForm(payload.data);
  }
}

// Shared brand shell every template renders its content inside. Colors
// match packages/ui/src/theme.css / TOKENS.md (Indigo palette).
const COLOR_PRIMARY = "#4F46E5";
const COLOR_PAGE_BG = "#F8FAFC";
const COLOR_TEXT = "#0F172A";
const COLOR_MUTED = "#64748B";

export interface LayoutContent {
  preheader: string;
  bodyHtml: string;
  bodyText: string;
}

/**
 * Wraps `bodyHtml` in the branded shell. The logo is referenced as
 * `cid:logo` — transports attach `getLogoBuffer()` under that same cid, so
 * the image renders inline without any external image request.
 */
export function renderLayout({ preheader, bodyHtml }: LayoutContent): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
  </head>
  <body style="margin:0;padding:0;background:${COLOR_PAGE_BG};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:${COLOR_TEXT};">
    <span style="display:none;max-height:0;overflow:hidden;">${escapeHtml(preheader)}</span>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${COLOR_PAGE_BG};padding:32px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;">
            <tr>
              <td style="padding:28px 32px 0 32px;">
                <img src="cid:logo" alt="Nia Core" height="28" style="display:block;" />
              </td>
            </tr>
            <tr>
              <td style="padding:24px 32px 32px 32px;font-size:15px;line-height:1.6;">
                ${bodyHtml}
              </td>
            </tr>
            <tr>
              <td style="padding:16px 32px 28px 32px;border-top:1px solid #EEF2FF;font-size:12px;color:${COLOR_MUTED};">
                Nia Core &middot; if you didn't expect this email, you can safely ignore it.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

export function renderButton(label: string, href: string): string {
  return `<a href="${escapeAttr(href)}" style="display:inline-block;margin-top:16px;padding:10px 20px;background:${COLOR_PRIMARY};color:#ffffff;text-decoration:none;border-radius:8px;font-weight:600;font-size:14px;">${escapeHtml(label)}</a>`;
}

export function renderCode(code: string): string {
  return `<div style="margin:20px 0;font-size:28px;font-weight:700;letter-spacing:6px;color:${COLOR_PRIMARY};">${escapeHtml(code)}</div>`;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/"/g, "&quot;");
}

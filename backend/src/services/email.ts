import { Resend } from 'resend';
import { config } from '../config';

const resend = new Resend(config.resendApiKey);

export interface AlertEmailPayload {
  to: string;
  keyword: string;
  matches: Array<{ title: string; price?: number | null; url: string }>;
  notificationId: string;
  backendUrl: string;
}

export async function sendAlertEmail(payload: AlertEmailPayload): Promise<void> {
  const { to, keyword, matches, notificationId, backendUrl } = payload;
  const landingUrl = `${backendUrl}/notifications/${notificationId}`;
  const dashboardUrl = `${config.frontendUrl}/dashboard`;

  const matchRows = matches
    .slice(0, 5)
    .map(
      (m) =>
        `<tr>
          <td style="padding:10px 14px; color:#E2E2E2; border-bottom:1px solid #1E1E1E;">
            <span style="display:inline-block; background:#4D7A3C; color:#fff; font-size:9px; padding:2px 6px; letter-spacing:0.1em; text-transform:uppercase; margin-right:8px; vertical-align:middle;">NEW</span>
            <a href="${m.url}" style="color:#4D7A3C; text-decoration:none;">${m.title}</a>
          </td>
          <td style="padding:10px 14px; color:#D4620A; font-weight:600; border-bottom:1px solid #1E1E1E; white-space:nowrap;">
            ${m.price ? `$${m.price.toFixed(2)}` : 'Check site'}
          </td>
        </tr>`
    )
    .join('');

  const itemCount = matches.length;
  const subject = `[FirearmAlert] ${itemCount} new item${itemCount > 1 ? 's' : ''}: "${keyword}"`;

  await resend.emails.send({
    from: config.fromEmail,
    to,
    subject,
    html: `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0; padding:0; background:#0D0D0D; font-family:Inter,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0D0D0D; padding:40px 20px;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#111111; border:1px solid #1E1E1E; border-top:3px solid #4D7A3C;">
        <tr>
          <td style="padding:28px 32px 16px;">
            <div style="font-size:11px; color:#6B7280; letter-spacing:0.2em; text-transform:uppercase; margin-bottom:8px;">
              Tactical Alert
            </div>
            <h1 style="margin:0; font-size:22px; color:#E2E2E2; letter-spacing:0.05em;">
              ${itemCount} new item${itemCount > 1 ? 's' : ''}: <span style="color:#4D7A3C;">${keyword}</span>
            </h1>
          </td>
        </tr>
        <tr>
          <td style="padding:0 32px 24px;">
            <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #1E1E1E;">
              <tr>
                <th style="padding:8px 14px; text-align:left; font-size:10px; color:#6B7280; text-transform:uppercase; letter-spacing:0.15em; background:#161616; border-bottom:1px solid #1E1E1E;">
                  Item
                </th>
                <th style="padding:8px 14px; text-align:left; font-size:10px; color:#6B7280; text-transform:uppercase; letter-spacing:0.15em; background:#161616; border-bottom:1px solid #1E1E1E;">
                  Price
                </th>
              </tr>
              ${matchRows}
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:0 32px 16px;">
            <a href="${landingUrl}" style="display:inline-block; background:#4D7A3C; color:#ffffff; padding:10px 24px; font-size:12px; letter-spacing:0.15em; text-transform:uppercase; text-decoration:none;">
              View New Items
            </a>
          </td>
        </tr>
        <tr>
          <td style="padding:0 32px 32px;">
            <a href="${dashboardUrl}" style="color:#6B7280; font-size:11px; text-decoration:underline;">
              Manage Alerts
            </a>
          </td>
        </tr>
        <tr>
          <td style="padding:16px 32px; border-top:1px solid #1E1E1E;">
            <p style="margin:0; font-size:11px; color:#4A4A4A; line-height:1.6;">
              FirearmAlert is a notification service. We are not affiliated with any retailer.
              Users are responsible for complying with all applicable Canadian firearm laws.
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`,
  });
}

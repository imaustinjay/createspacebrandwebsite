// The house mailer, shared by anything that has to put something in an inbox.
//
// Same env names and same fallbacks as netlify/functions/shop.mjs, which is
// where the convention comes from (and which in turn borrows it from the
// workspace's shared/mailCore.mjs). The difference here is the return: this
// distinguishes "no mailbox is configured" from "the mailbox refused it",
// because a webhook has to retry one and must never retry the other.
import nodemailer from 'nodemailer'
import { clean } from './catalog.mjs'

export const esc = (s = '') =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export function mailbox() {
  const to = clean(process.env.SHOP_EMAIL || process.env.PARTNERSHIPS_EMAIL) || 'hello@createspacebrand.com'
  const user = clean(process.env.MAIL_USER || process.env.TITAN_EMAIL)
  const password = clean(process.env.MAIL_PASSWORD || process.env.TITAN_PASSWORD)
  if (!to || !user || !password) return null
  return {
    to,
    user,
    password,
    host: clean(process.env.MAIL_SMTP_HOST || process.env.TITAN_SMTP_HOST) || 'smtp.titan.email',
    port: Number(clean(process.env.MAIL_SMTP_PORT || process.env.TITAN_SMTP_PORT)) || 465,
    fromName: clean(process.env.MAIL_FROM_NAME) || 'createspace · community + talent',
  }
}

// { ok: true } · { ok: false, reason: 'not-configured' } · { ok: false, reason: 'send-failed' }
export async function sendMail({ to, replyTo, subject, text, html }) {
  const box = mailbox()
  if (!box) return { ok: false, reason: 'not-configured' }

  const transporter = nodemailer.createTransport({
    host: box.host,
    port: box.port,
    secure: true,
    auth: { user: box.user, pass: box.password },
  })

  try {
    await transporter.sendMail({
      from: { name: box.fromName, address: box.user },
      to: to || box.to,
      replyTo: replyTo || undefined,
      subject,
      text,
      html,
    })
    return { ok: true }
  } catch (err) {
    console.error('mail: SMTP send failed —', err?.message || err)
    return { ok: false, reason: 'send-failed' }
  }
}

// The house's plain table, the same one the enquiry and shop desks send.
export function table(rows, heading) {
  return `
    <div style="font-family: Arial, sans-serif; color: #4E312C; background: #FFFFF0; padding: 28px;">
      <p style="font-size: 11px; font-weight: bold; letter-spacing: 2px; text-transform: uppercase; color: #567363; margin: 0 0 14px;">${esc(
        heading
      )} &middot; createspacebrand.com</p>
      <table style="border-collapse: collapse; background: #FFFFFF; border: 1px solid rgba(78,49,44,0.14); border-radius: 12px; width: 100%; max-width: 560px;">
        ${rows
          .map(
            ([k, v]) => `<tr>
          <td style="padding: 10px 16px; font-size: 12px; color: rgba(78,49,44,0.55); border-bottom: 1px solid rgba(78,49,44,0.10); white-space: nowrap; vertical-align: top;">${esc(k)}</td>
          <td style="padding: 10px 16px; font-size: 14px; border-bottom: 1px solid rgba(78,49,44,0.10); white-space: pre-wrap;">${esc(v)}</td>
        </tr>`
          )
          .join('')}
      </table>
    </div>`
}

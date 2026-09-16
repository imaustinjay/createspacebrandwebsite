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

// Port 465 is TLS from the first byte; 587 and 25 start in the clear and
// upgrade with STARTTLS. Nodemailer will not work this out for you — with
// `secure: true` on 587 it opens a TLS handshake against a server waiting to
// speak plain SMTP, and the send dies on a timeout that names neither the port
// nor the reason. Every provider's own setup page offers both numbers, so
// somebody following Google's or Zoho's instructions would set 587 and take
// the site's entire mail down, including the portal's own sign-in code.
export const secureFor = (port) => Number(port) === 465

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

// { ok: true }
// { ok: false, reason: 'not-configured' }
// { ok: false, reason: 'send-failed', detail } — `detail` is the mail server's
//   own words. It travels because the one place this matters most is the admin
//   portal's sign-in code: without it the operator is told to check two
//   variables that are demonstrably already set, and has to go reading function
//   logs to find out the password was rejected. Nodemailer's message here is
//   the SMTP reply ("Invalid login: 535 …"); it never contains the credential.
export async function sendMail({ to, replyTo, subject, text, html }) {
  const box = mailbox()
  if (!box) return { ok: false, reason: 'not-configured' }

  const transporter = nodemailer.createTransport({
    host: box.host,
    port: box.port,
    secure: secureFor(box.port),
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
    const detail = String(err?.message || err).slice(0, 300)
    console.error('mail: SMTP send failed —', detail)
    return { ok: false, reason: 'send-failed', detail, host: box.host, port: box.port, user: box.user }
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

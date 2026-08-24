// The brand's invoice email — the house's own, in the house's own colours.
//
// Stripe would happily send its invoice email, and it would look like
// Stripe. The billing desk keeps that switched off and sends this instead:
// the same wordmark, ivory and seal the shop's receipt carries, so the
// invoice reads as createspace from the subject line to the button. The one
// deliberate exception is where the button goes — Stripe's hosted invoice
// page — because that is where the card gets typed, and no card belongs
// anywhere near this repo.
//
// Same constraints as receipt.mjs: email HTML is 1999 HTML — tables, inline
// styles, Georgia standing in for Lora — and the palette carries the brand.
import { esc } from './mail.mjs'

const IVORY = '#FFFFF0'
const SEAL = '#4E312C'
const SAGE = '#567363'
const CARD = '#FFFFFF'
const HAIRLINE = 'rgba(78,49,44,0.12)'
const MUTED = 'rgba(78,49,44,0.55)'

const SANS = "'Raleway', -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif"
const SERIF = "'Lora', Georgia, 'Times New Roman', serif"

function longDate(iso) {
  if (!iso) return ''
  try {
    return new Intl.DateTimeFormat('en-US', { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(iso))
  } catch {
    return ''
  }
}

/**
 * The invoice email. Returns { subject, text, html }.
 *
 * lines: [{ description, display }] — already formatted money.
 */
export function brandInvoiceEmail({ number, contact, company, memo, lines, total, dueAt, payUrl, pdfUrl }) {
  const firstName = String(contact || '').trim().split(/\s+/)[0] || 'there'
  const who = company || contact || ''
  const due = longDate(dueAt)
  const support = 'hello@createspacebrand.com'

  const subject = `Invoice ${number} from createspace${due ? ` — due ${due}` : ''}`

  const text = [
    `${firstName} — the invoice for our work together is below.`,
    '',
    `Invoice ${number}${who ? ` · ${who}` : ''}`,
    memo ? memo : '',
    '',
    ...lines.map((l) => `${l.description}  ${l.display}`),
    '',
    `Total due: ${total}${due ? ` · by ${due}` : ''}`,
    '',
    `Pay it here (card or bank transfer, secured by Stripe):`,
    payUrl,
    pdfUrl ? `PDF for your records: ${pdfUrl}` : '',
    '',
    `Reply to this email and a person, not a queue, will answer — or write to ${support}.`,
    '',
    'createspace · community + talent',
    'createspacebrand.com',
  ]
    .filter((l) => l !== '')
    .join('\n')

  const rows = lines
    .map(
      (l, i) => `<tr><td style="padding:14px 22px;${i ? `border-top:1px solid ${HAIRLINE};` : ''}">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
          <td style="font-family:${SANS};font-size:14.5px;color:${SEAL};line-height:1.5;">${esc(l.description)}</td>
          <td align="right" style="font-family:${SANS};font-size:14.5px;color:${SEAL};white-space:nowrap;padding-left:16px;">${esc(l.display)}</td>
        </tr></table>
      </td></tr>`
    )
    .join('')

  const html = `<!doctype html>
<html><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${esc(subject)}</title>
</head>
<body style="margin:0;padding:0;background:${IVORY};-webkit-font-smoothing:antialiased;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(`Invoice ${number} · ${total}${due ? ` · due ${due}` : ''}`)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${IVORY};">
<tr><td align="center" style="padding:36px 16px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;">

  <!-- the wordmark, set the way the site sets it -->
  <tr><td style="padding:0 4px 26px;">
    <div style="font-family:${SERIF};font-style:italic;font-size:30px;color:${SEAL};line-height:1;">createspace</div>
    <div style="font-family:${SANS};font-size:10px;font-weight:700;letter-spacing:0.22em;text-transform:uppercase;color:${SAGE};margin-top:7px;">community + talent</div>
  </td></tr>

  <tr><td style="padding:0 4px 8px;">
    <span style="font-family:${SANS};font-size:10.5px;font-weight:700;letter-spacing:0.16em;text-transform:uppercase;color:${SAGE};">Invoice &middot; ${esc(number)}${
      who ? ` &middot; ${esc(who)}` : ''
    }</span>
  </td></tr>

  <tr><td style="padding:0 4px 6px;">
    <div style="font-family:${SERIF};font-size:32px;color:${SEAL};line-height:1.15;">${esc(firstName)} — for the work together.</div>
  </td></tr>

  <tr><td style="padding:0 4px 26px;">
    <div style="font-family:${SANS};font-size:15px;color:${MUTED};line-height:1.65;">${
      memo ? esc(memo) : 'The engagement is itemised below; the button takes the payment on a secured page.'
    }</div>
  </td></tr>

  <!-- the lines -->
  <tr><td style="padding:0 0 18px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${CARD};border:1px solid ${HAIRLINE};border-radius:16px;">
      ${rows}
      <tr><td style="padding:16px 22px;border-top:1px solid ${HAIRLINE};">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
          <td style="font-family:${SANS};font-size:12px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:${SAGE};">Total due${
            due ? ` &middot; by ${esc(due)}` : ''
          }</td>
          <td align="right" style="font-family:${SERIF};font-size:22px;color:${SEAL};white-space:nowrap;padding-left:16px;">${esc(total)}</td>
        </tr></table>
      </td></tr>
    </table>
  </td></tr>

  <!-- the button -->
  <tr><td style="padding:2px 4px 10px;">
    <a href="${esc(payUrl)}" style="display:inline-block;background:${SEAL};color:${IVORY};text-decoration:none;padding:14px 26px;border-radius:999px;font-family:${SANS};font-size:14.5px;font-weight:600;line-height:1;">Pay this invoice</a>
    ${pdfUrl ? `<a href="${esc(pdfUrl)}" style="display:inline-block;margin-left:14px;color:${SEAL};text-decoration:underline;font-family:${SANS};font-size:13.5px;">PDF for your records</a>` : ''}
  </td></tr>

  <tr><td style="padding:0 4px 26px;">
    <div style="font-family:${SANS};font-size:12.5px;color:${MUTED};line-height:1.6;">Card or bank transfer, secured and processed by Stripe — the payment page never shows a card field to us.</div>
  </td></tr>

  <tr><td style="padding:0 4px;">
    <div style="border-top:1px solid ${HAIRLINE};padding-top:18px;font-family:${SANS};font-size:12.5px;color:${MUTED};line-height:1.7;">
      Questions, or something on this invoice looks off? Reply to this email and a person, not a queue, will answer — or write to <a href="mailto:${esc(
        support
      )}" style="color:${SEAL};">${esc(support)}</a>.<br />
      createspace &middot; community + talent &middot; createspacebrand.com
    </div>
  </td></tr>

</table>
</td></tr>
</table>
</body></html>`

  return { subject, text, html }
}

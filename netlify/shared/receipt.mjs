// The receipt — the house's own, in the house's own colours.
//
// Stripe sends a perfectly good receipt of its own: a navy diagonal, a
// summary table, a carbon-removal line. It is not ours and its layout is not
// reachable from code — the dashboard exposes a logo and two colours, and
// nothing else. So this replaces it rather than decorating it. Turn Stripe's
// automatic receipt off (Settings → Customer emails → Successful payments)
// and a buyer gets one email instead of two, and it looks like the shop they
// just bought from.
//
// Which means it has to *be* a receipt, not a thank-you note: who sold it,
// what it cost, when, what card, and a reference to quote. Those are below,
// alongside the download links, because a buyer looking for their files and a
// buyer looking for their receipt are usually the same person an hour apart.
//
// Email HTML is 1999 HTML: tables for layout, inline styles, no flexbox, no
// webfonts a client will reliably load. The palette carries the brand instead
// — ivory, seal, sage — with Georgia standing in for Lora on the wordmark,
// which is the closest thing to it that every mail client already has.
import { esc } from './mail.mjs'

const IVORY = '#FFFFF0'
const SEAL = '#4E312C'
const SAGE = '#567363'
const CARD = '#FFFFFF'
const HAIRLINE = 'rgba(78,49,44,0.12)'
const MUTED = 'rgba(78,49,44,0.55)'
const FAINT = 'rgba(78,49,44,0.42)'

const SANS = "'Raleway', -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif"
const SERIF = "'Lora', Georgia, 'Times New Roman', serif"

// A receipt with a date an hour wrong is a receipt someone queries. The zone
// is configurable because this file has no business guessing where the shop
// is; UTC is the honest default rather than a plausible-looking lie.
export function receiptDate(seconds, timeZone) {
  const at = new Date((Number(seconds) || Math.floor(Date.now() / 1000)) * 1000)
  const zone = timeZone || 'UTC'
  try {
    return new Intl.DateTimeFormat('en-US', {
      dateStyle: 'long',
      timeStyle: 'short',
      timeZone: zone,
    }).format(at)
  } catch {
    return new Intl.DateTimeFormat('en-US', { dateStyle: 'long', timeStyle: 'short', timeZone: 'UTC' }).format(at)
  }
}

// "Visa •••• 4242", or nothing at all rather than a guess.
export function cardLine(card) {
  if (!card || !card.last4) return ''
  const brand = String(card.brand || '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
  return (brand ? brand + ' ' : '') + '•••• ' + card.last4
}

function button(href, label, background) {
  return `<a href="${esc(href)}" style="display:inline-block;background:${background};color:${IVORY};text-decoration:none;padding:12px 22px;border-radius:999px;font-family:${SANS};font-size:14px;font-weight:600;line-height:1;">${esc(
    label
  )}</a>`
}

// One product: what it is, what it cost, and how to get it.
function itemRow(line, last) {
  const border = last ? '' : `border-bottom:1px solid ${HAIRLINE};`
  const downloads = line.ready
    ? line.links
        .map(
          (k) =>
            `<span style="display:inline-block;margin:8px 8px 0 0;">${button(
              k.href,
              k.label + (k.size ? ' · ' + k.size : ''),
              SAGE
            )}</span>`
        )
        .join('')
    : `<span style="font-family:${SANS};font-size:13px;color:${MUTED};">Being finished — your link goes live the moment it is, and we'll write again.</span>`

  return `
  <tr><td style="padding:18px 22px;${border}">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      <td style="font-family:${SANS};font-size:16px;color:${SEAL};line-height:1.4;">${esc(line.name)}</td>
      <td align="right" style="font-family:${SANS};font-size:16px;color:${SEAL};white-space:nowrap;padding-left:16px;">${esc(
        line.display || ''
      )}</td>
    </tr></table>
    ${
      line.delivery
        ? `<div style="font-family:${SANS};font-size:12.5px;color:${MUTED};margin-top:4px;">${esc(line.delivery)}</div>`
        : ''
    }
    <div style="margin-top:6px;">${downloads}</div>
  </td></tr>`
}

/**
 * The buyer's email. Returns { subject, text, html }.
 *
 * lines: [{ name, delivery, display, ready, links: [{ label, size, href }] }]
 */
export function receiptEmail({
  reference,
  firstName,
  lines,
  total,
  paidAt,
  card,
  orderUrl,
  stripeReceiptUrl,
  joinCraft,
  trialOnly,
  anyReady,
  supportEmail,
}) {
  const support = supportEmail || 'hello@createspacebrand.com'
  const paidLine = trialOnly ? 'Nothing charged today' : total
  const paymentLine = [paidAt, cardLine(card)].filter(Boolean).join(' · ')

  const craftLine = joinCraft
    ? "You asked to be let into the craft — your seat is held, and you'll be let in the week the doors open."
    : 'The craft is there whenever you want it — no rush.'

  const subject = anyReady
    ? `Your downloads — ${reference}`
    : `Your order — ${reference}`

  // ------------------------------------------------------------ plain text
  const text = [
    `${firstName} — it's yours.`,
    '',
    ...lines.map((l) =>
      l.ready
        ? `${l.name}${l.display ? '  ' + l.display : ''}\n` +
          l.links.map((k) => `  ${k.label}${k.size ? ` (${k.size})` : ''}: ${k.href}`).join('\n')
        : `${l.name}${l.display ? '  ' + l.display : ''}\n  Being finished — we'll write again the moment it's ready.`
    ),
    '',
    `Total: ${paidLine}`,
    paymentLine ? `Paid: ${paymentLine}` : '',
    `Receipt: ${reference}`,
    '',
    `Your order lives here, permanently: ${orderUrl}`,
    '',
    craftLine,
    '',
    `Reply to this email and a person, not a queue, will answer — or write to ${support}.`,
    '',
    'createspace · community + talent',
    'createspacebrand.com',
  ]
    .filter((l) => l !== '')
    .join('\n')

  // ------------------------------------------------------------------ html
  const html = `<!doctype html>
<html><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${esc(subject)}</title>
</head>
<body style="margin:0;padding:0;background:${IVORY};-webkit-font-smoothing:antialiased;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(
    anyReady ? 'Your files are inside, and they are yours permanently.' : 'Your order is confirmed.'
  )}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${IVORY};">
<tr><td align="center" style="padding:36px 16px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;">

  <!-- the wordmark, set the way the site sets it -->
  <tr><td style="padding:0 4px 26px;">
    <div style="font-family:${SERIF};font-style:italic;font-size:30px;color:${SEAL};line-height:1;">createspace</div>
    <div style="font-family:${SANS};font-size:10px;font-weight:700;letter-spacing:0.22em;text-transform:uppercase;color:${SAGE};margin-top:7px;">community + talent</div>
  </td></tr>

  <tr><td style="padding:0 4px 8px;">
    <span style="font-family:${SANS};font-size:10.5px;font-weight:700;letter-spacing:0.16em;text-transform:uppercase;color:${SAGE};">Receipt &middot; ${esc(
    reference
  )}</span>
  </td></tr>

  <tr><td style="padding:0 4px 6px;">
    <div style="font-family:${SERIF};font-size:34px;color:${SEAL};line-height:1.15;">${esc(firstName)} — it's yours.</div>
  </td></tr>

  <tr><td style="padding:0 4px 26px;">
    <div style="font-family:${SANS};font-size:15px;color:${MUTED};line-height:1.65;">${
      anyReady
        ? 'Everything you bought is below. The links are yours permanently — keep this email.'
        : "Everything you bought is below. We'll write again the moment the files are ready to download."
    }</div>
  </td></tr>

  <!-- what was bought -->
  <tr><td style="padding:0 0 18px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${CARD};border:1px solid ${HAIRLINE};border-radius:16px;">
      ${lines.map((line, i) => itemRow(line, i === lines.length - 1)).join('')}
      <tr><td style="padding:16px 22px;border-top:2px solid ${HAIRLINE};background:${IVORY};border-radius:0 0 16px 16px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
          <td style="font-family:${SANS};font-size:15px;font-weight:700;color:${SEAL};">Total paid</td>
          <td align="right" style="font-family:${SANS};font-size:20px;color:${SEAL};white-space:nowrap;">${esc(
            paidLine
          )}</td>
        </tr></table>
        ${
          paymentLine
            ? `<div style="font-family:${SANS};font-size:12.5px;color:${FAINT};margin-top:6px;">${esc(paymentLine)}</div>`
            : ''
        }
      </td></tr>
    </table>
  </td></tr>

  <!-- the room it delivers into -->
  <tr><td style="padding:0 0 22px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:rgba(86,115,99,0.09);border-radius:14px;">
      <tr><td style="padding:18px 22px;">
        <div style="font-family:${SERIF};font-style:italic;font-size:19px;color:${SEAL};">the craft is expecting you</div>
        <div style="font-family:${SANS};font-size:13.5px;color:${MUTED};line-height:1.6;margin-top:5px;">${esc(craftLine)}</div>
      </td></tr>
    </table>
  </td></tr>

  <tr><td style="padding:0 4px 30px;">
    ${button(orderUrl, 'Open your order', SEAL)}
    <div style="font-family:${SANS};font-size:12.5px;color:${FAINT};margin-top:12px;line-height:1.6;">That link opens this order on any device, for as long as you want it.</div>
  </td></tr>

  <!-- the footer a receipt needs -->
  <tr><td style="padding:22px 4px 0;border-top:1px solid ${HAIRLINE};">
    <div style="font-family:${SANS};font-size:12.5px;color:${MUTED};line-height:1.8;">
      Reply to this email and a person — not a queue — will answer.<br />
      <a href="https://createspacebrand.com" style="color:${SAGE};text-decoration:none;">createspacebrand.com</a>
      &nbsp;&middot;&nbsp;
      <a href="mailto:${esc(support)}" style="color:${SAGE};text-decoration:none;">${esc(support)}</a>
      ${
        stripeReceiptUrl
          ? `<br /><a href="${esc(
              stripeReceiptUrl
            )}" style="color:${FAINT};text-decoration:underline;">Your card issuer's receipt from Stripe</a>`
          : ''
      }
    </div>
    <div style="font-family:${SANS};font-size:11.5px;color:${FAINT};margin-top:14px;line-height:1.7;">
      createspace &middot; community + talent &nbsp;&middot;&nbsp; Payments processed by Stripe.<br />
      Digital products are non-refundable once downloaded — see the <a href="https://createspacebrand.com/terms/" style="color:${FAINT};">terms of sale</a>.
    </div>
  </td></tr>

</table>
</td></tr>
</table>
</body></html>`

  return { subject, text, html }
}

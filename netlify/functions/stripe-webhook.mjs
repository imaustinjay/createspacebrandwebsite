// POST /api/stripe-webhook — Stripe telling us an order actually happened.
//
// The return page is not proof of payment: a buyer can close the tab, lose
// signal, or pay by a method that clears hours later. This is the side of the
// checkout that can be trusted, so this is the side that fulfils — it puts the
// order in the house inbox and writes to the buyer.
//
// Two rules it lives by:
//   · Verify the signature before believing a byte of the body. An unsigned
//     POST here is an unknown stranger claiming somebody paid.
//   · Answer 2xx unless a retry would actually help. Stripe retries a 5xx for
//     days, which is exactly right for a mailbox that's briefly down and
//     exactly wrong for a mailbox that was never configured.
import { SHELF, clean, money, shelfIdForPrice, siteOrigin, stripeClient } from '../shared/catalog.mjs'
import { esc, mailbox, sendMail, table } from '../shared/mail.mjs'

const HANDLED = new Set([
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
])

// Stripe can deliver the same event more than once — by design, and after
// every 5xx we answer. Fulfilment has to be idempotent, so remember what has
// already been dealt with. Blobs when they're there; memory when they're not,
// which still covers the burst of retries a single cold instance sees.
const memorySeen = new Set()

async function alreadyDone(key) {
  if (memorySeen.has(key)) return true
  try {
    const { getStore } = await import('@netlify/blobs')
    const store = getStore('stripe-events')
    return Boolean(await store.get(key))
  } catch {
    return false
  }
}

async function markDone(key) {
  memorySeen.add(key)
  try {
    const { getStore } = await import('@netlify/blobs')
    const store = getStore('stripe-events')
    await store.set(key, new Date().toISOString())
  } catch {
    /* the in-memory set still covers this instance's retries */
  }
}

export default async (req) => {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 })

  const stripe = stripeClient()
  const secret = clean(process.env.STRIPE_WEBHOOK_SECRET)
  if (!stripe || !secret) {
    // Nothing to retry: this is a missing environment variable, not a blip.
    console.error('stripe-webhook: not configured — STRIPE_SECRET_KEY and/or STRIPE_WEBHOOK_SECRET missing')
    return Response.json({ received: true, handled: false, reason: 'not-configured' })
  }

  const signature = req.headers.get('stripe-signature') || ''
  const raw = await req.text()

  let event
  try {
    event = await stripe.webhooks.constructEventAsync(raw, signature, secret)
  } catch (err) {
    // A bad signature is either an attacker or the wrong signing secret for
    // this endpoint. Both are 400s — retrying changes neither.
    console.error('stripe-webhook: signature rejected —', err?.message || err)
    return Response.json({ error: 'Invalid signature' }, { status: 400 })
  }

  if (!HANDLED.has(event.type)) {
    return Response.json({ received: true, handled: false })
  }

  if (await alreadyDone(event.id)) {
    console.log('stripe-webhook: already handled', { id: event.id, type: event.type })
    return Response.json({ received: true, handled: true, duplicate: true })
  }

  const session = event.data.object

  if (event.type === 'checkout.session.async_payment_failed') {
    console.warn('stripe-webhook: async payment failed', {
      reference: session.client_reference_id,
      session: session.id,
    })
    await markDone(event.id)
    return Response.json({ received: true, handled: true })
  }

  // `completed` fires when the buyer finishes the page — which for a delayed
  // method is before any money has moved. Wait for the succeeded event
  // instead of thanking someone for a payment that may still fail.
  if (event.type === 'checkout.session.completed' && session.payment_status === 'unpaid') {
    console.log('stripe-webhook: awaiting async payment', { session: session.id })
    await markDone(event.id)
    return Response.json({ received: true, handled: true, pending: true })
  }

  // The event's copy of the session carries no line items; fetch them.
  let full = session
  try {
    full = await stripe.checkout.sessions.retrieve(session.id, { expand: ['line_items'] })
  } catch (err) {
    // Worth a retry — Stripe was reachable a second ago.
    console.error('stripe-webhook: session read failed —', err?.message || err)
    return Response.json({ error: 'Could not read the session' }, { status: 500 })
  }

  const meta = full.metadata || {}
  const reference = full.client_reference_id || meta.reference || full.id
  const email = full.customer_details?.email || full.customer_email || ''
  const name = full.customer_details?.name || meta.name || ''
  const joinCraft = meta.joinCraft !== 'no'
  const total = money(full.amount_total, full.currency)

  const lines = (full.line_items?.data || []).map((line) => {
    const id = shelfIdForPrice(line.price)
    const shelf = id ? SHELF[id] : null
    return {
      name: shelf ? shelf.name : line.description || 'Item',
      delivery: shelf ? shelf.delivery : '',
      display: money(line.amount_total, full.currency),
    }
  })

  const box = mailbox()
  if (!box) {
    // The payment is real and is in the Stripe dashboard either way — but
    // nobody in the house will hear about it, so say so loudly in the log.
    // Not a 5xx: no number of retries will configure SMTP.
    console.error('stripe-webhook: PAID BUT UNANNOUNCED — no mailbox configured', { reference, email, total })
    await markDone(event.id)
    return Response.json({ received: true, handled: true, notified: false })
  }

  const origin = siteOrigin(req)
  const orderUrl = `${origin}/shop/order/?session_id=${encodeURIComponent(full.id)}`
  const itemLines = lines.map((l) => `${l.name} — ${l.display}`).join('\n')

  // ------------------------------------------------------- the house inbox
  const rows = [
    ['Reference', reference],
    ['Name', name || '—'],
    ['Email', email || '—'],
    ['Handle', meta.handle || '—'],
    ['Items', lines.map((l) => `${l.name} (${l.display})`).join('\n') || '—'],
    ['Total', total],
    ['Type', full.mode === 'subscription' ? 'Membership (recurring)' : 'One-time'],
    ['the craft', joinCraft ? 'Yes — add them when the doors open' : 'Not joining'],
    ['Stripe session', full.id],
  ]

  const internal = await sendMail({
    to: box.to,
    replyTo: email ? (name ? { name, address: email } : email) : undefined,
    subject: `Order ${reference} — ${total}`,
    text: rows.map(([k, v]) => `${k}: ${v}`).join('\n'),
    html: table(rows, `Order ${reference}`),
  })

  // ---------------------------------------------------------- the customer
  // Stripe sends its own receipt; this is the part Stripe can't write —
  // what was bought, when it unlocks, and where to find it again.
  let confirmation = { ok: true }
  if (email) {
    const firstName = (name || '').trim().split(/\s+/)[0] || 'there'
    confirmation = await sendMail({
      to: email,
      subject: `Your order — ${reference}`,
      text: [
        `${firstName} — it's yours.`,
        '',
        itemLines,
        '',
        `Total: ${total}`,
        `Reference: ${reference}`,
        '',
        'Your files unlock on August 17, and the links are yours permanently.',
        `Your order lives here: ${orderUrl}`,
        '',
        joinCraft
          ? "You asked to be let into the craft — your seat is held, and you'll be let in the week the doors open."
          : 'The craft is there whenever you want it — no rush.',
        '',
        'Reply to this email and a person, not a queue, will answer.',
        '',
        'createspace · community + talent',
      ].join('\n'),
      html: `
        <div style="font-family: Arial, sans-serif; color: #4E312C; background: #FFFFF0; padding: 32px;">
          <p style="font-size: 11px; font-weight: bold; letter-spacing: 2px; text-transform: uppercase; color: #567363; margin: 0 0 18px;">Order ${esc(
            reference
          )} &middot; createspacebrand.com</p>
          <p style="font-size: 22px; margin: 0 0 18px;">${esc(firstName)} — it's yours.</p>
          <table style="border-collapse: collapse; background: #FFFFFF; border: 1px solid rgba(78,49,44,0.14); border-radius: 12px; width: 100%; max-width: 560px;">
            ${lines
              .map(
                (l) => `<tr>
              <td style="padding: 12px 16px; font-size: 15px; border-bottom: 1px solid rgba(78,49,44,0.10);">${esc(l.name)}<br />
                <span style="font-size: 12px; color: rgba(78,49,44,0.55);">${esc(l.delivery)}</span></td>
              <td style="padding: 12px 16px; font-size: 15px; text-align: right; white-space: nowrap; border-bottom: 1px solid rgba(78,49,44,0.10);">${esc(
                l.display
              )}</td>
            </tr>`
              )
              .join('')}
            <tr>
              <td style="padding: 12px 16px; font-size: 15px; font-weight: bold;">Total</td>
              <td style="padding: 12px 16px; font-size: 15px; font-weight: bold; text-align: right;">${esc(total)}</td>
            </tr>
          </table>
          <p style="font-size: 14px; line-height: 1.7; margin: 20px 0 0; max-width: 560px;">Your files unlock on <strong>August 17</strong> — the links go live the moment they do, and they're yours permanently.</p>
          <p style="font-size: 14px; line-height: 1.7; margin: 12px 0 0; max-width: 560px;">${
            joinCraft
              ? "You asked to be let into <em>the craft</em> — your seat is held, and you'll be let in the week the doors open."
              : '<em>the craft</em> is there whenever you want it — no rush.'
          }</p>
          <p style="margin: 24px 0 0;"><a href="${esc(orderUrl)}" style="display: inline-block; background: #4E312C; color: #FFFFF0; text-decoration: none; padding: 13px 24px; border-radius: 999px; font-size: 14px;">Open your order</a></p>
          <p style="font-size: 13px; color: rgba(78,49,44,0.55); margin: 24px 0 0;">Reply to this email and a person — not a queue — will answer.</p>
        </div>`,
    })
  }

  if (!internal.ok || !confirmation.ok) {
    const reason = internal.reason || confirmation.reason
    if (reason === 'send-failed') {
      // Transient: let Stripe bring it back. Nothing is marked done, so the
      // retry sends properly rather than being swallowed as a duplicate.
      console.error('stripe-webhook: notification failed, asking Stripe to retry', { reference })
      return Response.json({ error: 'Notification failed' }, { status: 500 })
    }
  }

  await markDone(event.id)
  console.log('stripe-webhook: fulfilled', { reference, total, items: lines.length, session: full.id })
  return Response.json({ received: true, handled: true })
}

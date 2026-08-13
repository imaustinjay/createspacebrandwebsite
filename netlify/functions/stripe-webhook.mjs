// POST /api/stripe-webhook — Stripe telling us an order actually happened.
//
// The return page is not proof of payment: a buyer can close the tab, lose
// signal, or pay by a method that clears hours later. This is the side of the
// checkout that can be trusted, so this is the side that delivers — it mints
// the download links, writes to the buyer, and puts the order in the house
// inbox.
//
// Three rules it lives by:
//   · Verify the signature before believing a byte of the body. An unsigned
//     POST here is an unknown stranger claiming somebody paid.
//   · Answer 2xx unless a retry would actually help. Stripe retries a 5xx for
//     days, which is right for a mailbox that's briefly down and wrong for a
//     mailbox that was never configured.
//   · Deliver exactly once. Every order is keyed by its payment intent and
//     carries a `delivered` flag, so a replayed event re-sends nothing.
import { SHELF, clean, money, siteOrigin, stripeClient } from '../shared/catalog.mjs'
import { esc, mailbox, sendMail, table } from '../shared/mail.mjs'
import { deliverableCount, ensureOrder, manifests, markDelivered, readableSize } from '../shared/storage.mjs'

const HANDLED = new Set([
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
  'setup_intent.succeeded',
])

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

  const intent = event.data.object
  const meta = intent.metadata || {}

  if (event.type === 'payment_intent.payment_failed') {
    console.warn('stripe-webhook: payment failed', {
      reference: meta.reference,
      intent: intent.id,
      reason: intent.last_payment_error?.message,
    })
    return Response.json({ received: true, handled: true })
  }

  // The order was written at checkout, keyed by this intent, before the card
  // was asked for. If it isn't here, this payment came from somewhere that
  // isn't this storefront — say so and don't invent an order for it.
  const order = await ensureOrder(intent.id, {
    reference: meta.reference || null,
    email: intent.receipt_email || null,
    name: meta.name || null,
    handle: meta.handle || '',
    joinCraft: meta.joinCraft !== 'no',
    items: String(meta.cart || '').split(',').filter(Boolean),
    currency: intent.currency || 'usd',
    amount: typeof intent.amount === 'number' ? intent.amount : 0,
    kind: event.type === 'setup_intent.succeeded' ? 'membership' : 'one-time',
  })

  if (order.delivered) {
    console.log('stripe-webhook: already delivered', { reference: order.reference, intent: intent.id })
    return Response.json({ received: true, handled: true, duplicate: true })
  }

  if (!order.items?.length) {
    console.warn('stripe-webhook: a payment with no cart behind it', { intent: intent.id })
    return Response.json({ received: true, handled: false, reason: 'no-order' })
  }

  const shelves = await manifests(order.items)
  const origin = siteOrigin(req)
  const total = money(order.amount, order.currency)
  const trialOnly = event.type === 'setup_intent.succeeded'

  // What each product actually delivers, right now. A product with nothing
  // uploaded yet is not an error — it's a line that says "unlocks when it's
  // ready" instead of a link that 404s.
  const lines = order.items.map((id) => {
    const shelf = SHELF[id] || { name: id, delivery: '' }
    const entry = shelves[id] || { files: [], links: [] }
    const line = (order.lines || []).find((l) => l.id === id)
    const links = [
      ...entry.files.map((f) => ({
        label: f.label || f.name,
        size: readableSize(f.size),
        href: `${origin}/api/download?token=${encodeURIComponent(order.token)}&item=${encodeURIComponent(id)}&file=${encodeURIComponent(f.name)}`,
      })),
      ...entry.links.map((l, i) => ({
        label: l.label || 'Open',
        size: '',
        href: `${origin}/api/download?token=${encodeURIComponent(order.token)}&item=${encodeURIComponent(id)}&link=${i}`,
      })),
    ]
    return {
      id,
      name: shelf.name,
      delivery: shelf.delivery,
      display: line ? money(line.amount, order.currency) : '',
      ready: deliverableCount(entry) > 0,
      links,
    }
  })

  const anyReady = lines.some((l) => l.ready)
  const orderUrl = `${origin}/shop/order/?token=${encodeURIComponent(order.token)}`

  const box = mailbox()
  if (!box) {
    // The payment is real and is in the Stripe dashboard either way — but
    // nobody hears about it and nobody gets their files, so say so loudly.
    // Not a 5xx: no number of retries will configure SMTP.
    console.error('stripe-webhook: PAID BUT UNDELIVERED — no mailbox configured', {
      reference: order.reference,
      email: order.email,
      total,
    })
    await markDelivered(intent.id, { notified: false })
    return Response.json({ received: true, handled: true, notified: false })
  }

  // ------------------------------------------------------- the house inbox
  const rows = [
    ['Reference', order.reference || '—'],
    ['Name', order.name || '—'],
    ['Email', order.email || '—'],
    ['Handle', order.handle || '—'],
    ['Items', lines.map((l) => `${l.name}${l.display ? ` (${l.display})` : ''}${l.ready ? '' : '  ← no files uploaded'}`).join('\n')],
    ['Total', trialOnly ? 'Nothing today — trial' : total],
    ['Type', order.kind === 'membership' ? 'Membership (recurring)' : 'One-time'],
    ['the craft', order.joinCraft ? 'Yes — add them when the doors open' : 'Not joining'],
    ['Delivered', anyReady ? 'Files sent' : 'Nothing to send yet — upload them and re-send'],
    ['Stripe intent', intent.id],
  ]

  const internal = await sendMail({
    to: box.to,
    replyTo: order.email ? (order.name ? { name: order.name, address: order.email } : order.email) : undefined,
    subject: `Order ${order.reference || intent.id} — ${trialOnly ? 'trial started' : total}${anyReady ? '' : ' — FILES MISSING'}`,
    text: rows.map(([k, v]) => `${k}: ${v}`).join('\n'),
    html: table(rows, `Order ${order.reference || intent.id}`),
  })

  // ---------------------------------------------------------- the customer
  // The whole point of the automation: the files arrive with the receipt,
  // not on a date in a calendar.
  let confirmation = { ok: true }
  if (order.email) {
    const firstName = (order.name || '').trim().split(/\s+/)[0] || 'there'
    const textLines = lines.map((l) =>
      l.ready
        ? `${l.name}\n${l.links.map((k) => `  ${k.label}${k.size ? ` (${k.size})` : ''}: ${k.href}`).join('\n')}`
        : `${l.name}\n  Being finished — your link goes live the moment it's ready, and we'll write again.`
    )

    confirmation = await sendMail({
      to: order.email,
      subject: anyReady ? `Your downloads — ${order.reference || 'createspace'}` : `Your order — ${order.reference || 'createspace'}`,
      text: [
        `${firstName} — it's yours.`,
        '',
        textLines.join('\n\n'),
        '',
        trialOnly ? 'Nothing was charged today.' : `Total: ${total}`,
        `Reference: ${order.reference || intent.id}`,
        '',
        `Your order lives here, permanently: ${orderUrl}`,
        '',
        order.joinCraft
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
            order.reference || intent.id
          )} &middot; createspacebrand.com</p>
          <p style="font-size: 22px; margin: 0 0 8px;">${esc(firstName)} — it's yours.</p>
          <p style="font-size: 14px; line-height: 1.7; margin: 0 0 22px; max-width: 560px; color: rgba(78,49,44,0.7);">${
            anyReady
              ? 'Everything you bought is below. The links are yours permanently — save this email.'
              : "Everything you bought is below. We'll write again the moment the files are ready to download."
          }</p>
          ${lines
            .map(
              (l) => `<table style="border-collapse: collapse; background: #FFFFFF; border: 1px solid rgba(78,49,44,0.14); border-radius: 12px; width: 100%; max-width: 560px; margin: 0 0 14px;">
            <tr><td style="padding: 16px 18px 6px;">
              <span style="font-size: 17px;">${esc(l.name)}</span>
              ${l.display ? `<span style="float: right; font-size: 15px; color: rgba(78,49,44,0.55);">${esc(l.display)}</span>` : ''}
              <br /><span style="font-size: 12px; color: rgba(78,49,44,0.55);">${esc(l.delivery)}</span>
            </td></tr>
            <tr><td style="padding: 4px 18px 18px;">
              ${
                l.ready
                  ? l.links
                      .map(
                        (k) => `<a href="${esc(k.href)}" style="display: inline-block; background: #567363; color: #FFFFF0; text-decoration: none; padding: 10px 18px; border-radius: 999px; font-size: 13px; margin: 6px 6px 0 0;">${esc(
                          k.label
                        )}${k.size ? ` &middot; ${esc(k.size)}` : ''}</a>`
                      )
                      .join('')
                  : `<span style="font-size: 13px; color: rgba(78,49,44,0.55);">Being finished — your link goes live the moment it's ready, and we'll write again.</span>`
              }
            </td></tr>
          </table>`
            )
            .join('')}
          <p style="font-size: 15px; margin: 18px 0 0;"><strong>${
            trialOnly ? 'Nothing was charged today.' : `Total: ${esc(total)}`
          }</strong></p>
          <p style="font-size: 14px; line-height: 1.7; margin: 12px 0 0; max-width: 560px;">${
            order.joinCraft
              ? "You asked to be let into <em>the craft</em> — your seat is held, and you'll be let in the week the doors open."
              : '<em>the craft</em> is there whenever you want it — no rush.'
          }</p>
          <p style="margin: 24px 0 0;"><a href="${esc(orderUrl)}" style="display: inline-block; background: #4E312C; color: #FFFFF0; text-decoration: none; padding: 13px 24px; border-radius: 999px; font-size: 14px;">Open your order</a></p>
          <p style="font-size: 13px; color: rgba(78,49,44,0.55); margin: 24px 0 0;">Reply to this email and a person — not a queue — will answer.</p>
        </div>`,
    })
  }

  if (internal.reason === 'send-failed' || confirmation.reason === 'send-failed') {
    // Transient: let Stripe bring it back. Nothing is marked delivered, so
    // the retry sends properly rather than being swallowed as a duplicate.
    console.error('stripe-webhook: delivery failed, asking Stripe to retry', { reference: order.reference })
    return Response.json({ error: 'Delivery failed' }, { status: 500 })
  }

  await markDelivered(intent.id, { notified: true, filesSent: anyReady })
  console.log('stripe-webhook: delivered', {
    reference: order.reference,
    total,
    items: lines.length,
    files: anyReady,
    intent: intent.id,
  })
  return Response.json({ received: true, handled: true, filesSent: anyReady })
}

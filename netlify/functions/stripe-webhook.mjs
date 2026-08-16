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
import { mailbox, sendMail, table } from '../shared/mail.mjs'
import { cardLine, receiptDate, receiptEmail } from '../shared/receipt.mjs'
import { deliverableCount, ensureOrder, manifests, markDelivered, readableSize } from '../shared/storage.mjs'

const HANDLED = new Set([
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
  'setup_intent.succeeded',
])

// `pi_00000000000000` and friends — the object Stripe's dashboard sends when
// you press "Send test event". Never a real intent, which always carries
// random characters.
const PLACEHOLDER_ID = /^[a-z]+_0+$/

// STRIPE_WEBHOOK_SECRET may hold more than one, separated by commas or
// whitespace, and each is tried until one verifies.
//
// This exists for the two moments it would otherwise bite. **Test and live are
// separate endpoints with separate signing secrets** — holding both means the
// sandbox keeps working after the switch to live, so a test purchase is always
// available to check delivery with. And **rotating a secret** stops being a
// window where signatures fail: add the new one, move Stripe over, drop the
// old one, with the shop up throughout.
//
// Trying several is not a weakening: each is a full HMAC check, and a forged
// signature fails every one of them.
function webhookSecrets() {
  return clean(process.env.STRIPE_WEBHOOK_SECRET)
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

export default async (req) => {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 })

  const stripe = stripeClient()
  const secrets = webhookSecrets()
  if (!stripe || !secrets.length) {
    // Nothing to retry: this is a missing environment variable, not a blip.
    console.error('stripe-webhook: not configured — STRIPE_SECRET_KEY and/or STRIPE_WEBHOOK_SECRET missing')
    return Response.json({ received: true, handled: false, reason: 'not-configured' })
  }

  const signature = req.headers.get('stripe-signature') || ''
  const raw = await req.text()

  let event = null
  let lastError = null
  for (const secret of secrets) {
    try {
      event = await stripe.webhooks.constructEventAsync(raw, signature, secret)
      break
    } catch (err) {
      lastError = err
    }
  }
  if (!event) {
    // A bad signature is either an attacker or the wrong signing secret for
    // this endpoint. Both are 400s — retrying changes neither.
    console.error('stripe-webhook: signature rejected —', lastError?.message || lastError)
    return Response.json({ error: 'Invalid signature' }, { status: 400 })
  }

  if (!HANDLED.has(event.type)) {
    return Response.json({ received: true, handled: false })
  }

  const intent = event.data.object
  const meta = intent.metadata || {}

  // Stripe's dashboard "Send test event" posts a real, correctly signed event
  // carrying a placeholder object — an id of nothing but zeros. Getting a 200
  // back is the one free way to prove STRIPE_WEBHOOK_SECRET is right without
  // spending money, so answer it as the check it is rather than letting it
  // fall through to the warning meant for a stranger's payment.
  if (PLACEHOLDER_ID.test(intent.id || '')) {
    console.log('stripe-webhook: dashboard test event — signature verified, nothing to deliver', {
      type: event.type,
    })
    return Response.json({ received: true, handled: false, reason: 'test-event', signature: 'ok' })
  }

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

  // What the receipt calls the payment: "Visa •••• 4242", and Stripe's own
  // hosted receipt as a footnote for anyone who wants the processor's copy.
  // Neither is worth failing a delivery over, so a miss here is just a miss.
  let paidWith = null
  let stripeReceiptUrl = ''
  if (!trialOnly && intent.latest_charge) {
    try {
      const charge = await stripe.charges.retrieve(
        typeof intent.latest_charge === 'string' ? intent.latest_charge : intent.latest_charge.id
      )
      paidWith = charge.payment_method_details?.card || null
      stripeReceiptUrl = charge.receipt_url || ''
    } catch (err) {
      console.warn('stripe-webhook: could not read the charge for the receipt —', err?.message || err)
    }
  }

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
    ['Paid with', cardLine(paidWith) || '—'],
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
  // The house's own receipt, replacing Stripe's — see netlify/shared/receipt.mjs
  // for why. It carries the files and the proof of purchase together, because
  // the person hunting for one is usually the person who wanted the other an
  // hour earlier.
  let confirmation = { ok: true }
  if (order.email) {
    confirmation = await sendMail({
      to: order.email,
      ...receiptEmail({
        reference: order.reference || intent.id,
        firstName: (order.name || '').trim().split(/\s+/)[0] || 'there',
        lines,
        total,
        paidAt: receiptDate(intent.created, clean(process.env.SHOP_TIMEZONE)),
        card: paidWith,
        orderUrl,
        stripeReceiptUrl,
        joinCraft: order.joinCraft,
        trialOnly,
        anyReady,
        supportEmail: box.to,
      }),
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

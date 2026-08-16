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
import { clean, siteOrigin, stripeClient } from '../shared/catalog.mjs'
import { deliverOrder } from '../shared/deliver.mjs'
import { ensureOrder } from '../shared/storage.mjs'

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

  const outcome = await deliverOrder({
    order,
    intent,
    stripe,
    origin: siteOrigin(req),
    trialOnly: event.type === 'setup_intent.succeeded',
    via: 'webhook',
  })

  if (outcome.retry) {
    // Transient — let Stripe bring it back. Nothing is marked delivered, so
    // the retry sends properly rather than being swallowed as a duplicate.
    return Response.json({ error: 'Delivery failed' }, { status: 500 })
  }

  return Response.json({ received: true, handled: true, filesSent: Boolean(outcome.filesSent) })
}

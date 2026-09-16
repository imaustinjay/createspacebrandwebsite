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
import { clean, siteOrigin, stripeClient, subscriptionInvoice } from '../shared/catalog.mjs'
import { deliverOrder } from '../shared/deliver.mjs'
import { ensureOrder, markDelivered, orderByIntent } from '../shared/storage.mjs'
import { SERVICES } from '../shared/services.mjs'
import { commissionFromOrder, deliverCommission, flushOutbox } from '../shared/commission.mjs'

const HANDLED = new Set([
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
  'setup_intent.succeeded',
  // The second door into a done-for-you engagement. Not every client is sent
  // to a checkout — some are invoiced, and an invoice that goes paid has to
  // reach the desk the same way a card does, or the one purchase path the
  // agency uses most is the one the automation never sees.
  'invoice.paid',
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

  // An INVOICE went paid. Handled entirely apart from the branches below,
  // which are written for a PaymentIntent: the object has a different shape,
  // a different id space, and — most importantly — no order record behind it.
  if (event.type === 'invoice.paid') return invoicePaid(intent)

  // A SERVICE, not a cart of files. Nothing to download and nothing to email a
  // link to — what this payment bought is two weeks of a team's work, so the
  // delivery is a commission crossing to the workspace, which opens the
  // engagement and writes to the client itself.
  //
  // It lives here rather than inside deliverOrder because the two have nothing
  // in common but the word: one mints download tokens, the other opens a
  // fortnight of work. Sharing a function between them would have meant a
  // branch at the top of every line of it.
  if (meta.kind === 'service') {
    const service = SERVICES[meta.service]
    if (!service) {
      console.error('stripe-webhook: a service payment naming a service we do not sell —', meta.service)
      return Response.json({ received: true, handled: false, reason: 'unknown-service' })
    }

    const order = await ensureOrder(intent.id, {
      reference: meta.reference || null,
      email: intent.receipt_email || null,
      name: meta.name || null,
      handle: meta.handle || '',
      platform: meta.platform || '',
      niche: meta.niche || '',
      notes: meta.notes || '',
      joinCraft: meta.joinCraft === 'yes',
      kind: 'service',
      service: meta.service,
      mode: meta.mode === 'deposit' ? 'deposit' : 'full',
      items: [],
      currency: intent.currency || 'usd',
      amount: typeof intent.amount === 'number' ? intent.amount : 0,
      fullAmount: Number(meta.fullAmount) > 0 ? Number(meta.fullAmount) : 0,
    })

    if (order.delivered) {
      console.log('stripe-webhook: service already commissioned', { reference: order.reference, intent: intent.id })
      return Response.json({ received: true, handled: true, duplicate: true })
    }

    const answers = {}
    if (order.niche) answers['Your niche, in your own words'] = order.niche
    if (order.handle) answers['Your primary platform (and handle)'] = [order.platform, `@${order.handle}`].filter(Boolean).join(' · ')

    const sent = await deliverCommission(
      commissionFromOrder({ order, service, mode: order.mode, intent, answers, notes: order.notes || '' }),
    )

    if (sent.ok) {
      // Marked delivered only once the workspace has it. A commission held in
      // the outbox is NOT a delivered order, and must not be treated as one by
      // the confirmation page or by a Stripe retry.
      await markDelivered(intent.id, { via: 'webhook', engagement: sent.code || sent.engagementId || '' })
      flushOutbox({ limit: 5 }).catch(() => {})
      console.log('stripe-webhook: service commissioned', { reference: order.reference, service: meta.service, engagement: sent.code || '' })
      return Response.json({ received: true, handled: true, engagement: sent.code || '' })
    }

    // Held. A 500 brings Stripe back, which is the cheapest retry available —
    // and the outbox means the commission survives even if it never does.
    console.error('stripe-webhook: service commission HELD —', sent.error)
    return Response.json({ error: 'Commission held' }, { status: sent.retry === false ? 200 : 500 })
  }

  // The order was written at checkout, keyed by this intent, before the card
  // was asked for. If it isn't here, this payment came from somewhere that
  // isn't this storefront — say so and don't invent an order for it.
  //
  // "Don't invent" used to be a thing the code said and not a thing it did.
  // ensureOrder ran unconditionally and only then was the empty cart noticed,
  // so every payment that isn't a storefront purchase — an agency invoice paid
  // on Stripe's hosted page, a craft membership renewing off-session, both of
  // which produce a payment_intent.succeeded of their own — left a record
  // under `by-intent/` with no cart and a live download token. Two consumers
  // read that prefix blind and filter nothing: the stockroom ledger, where it
  // appears as an undelivered order, and the account portal's purchase scan,
  // whose 500-record window it quietly consumes. Now the cart is checked
  // first, and a payment with nothing behind it leaves nothing behind.
  const cart = String(meta.cart || '').split(',').filter(Boolean)
  const existing = await orderByIntent(intent.id)
  if (!existing && !cart.length) {
    console.warn('stripe-webhook: a payment with no cart behind it', { intent: intent.id, type: event.type })
    return Response.json({ received: true, handled: false, reason: 'no-order' })
  }

  const order =
    existing ||
    (await ensureOrder(intent.id, {
      reference: meta.reference || null,
      email: intent.receipt_email || null,
      name: meta.name || null,
      handle: meta.handle || '',
      joinCraft: meta.joinCraft !== 'no',
      items: cart,
      currency: intent.currency || 'usd',
      amount: typeof intent.amount === 'number' ? intent.amount : 0,
      kind: event.type === 'setup_intent.succeeded' ? 'membership' : 'one-time',
    }))

  if (order.delivered) {
    console.log('stripe-webhook: already delivered', { reference: order.reference, intent: intent.id })
    return Response.json({ received: true, handled: true, duplicate: true })
  }

  if (!order.items?.length) {
    console.warn('stripe-webhook: an order with an empty cart', { intent: intent.id })
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

// ── A paid invoice, as a commission ───────────────────────────────────────
//
// The agency's other way of being paid. A client who is invoiced rather than
// sent to a checkout used to reach the desk not at all: `invoice.paid` was not
// in HANDLED, so every one of them returned 2xx-and-do-nothing, and an
// engagement somebody had just paid for simply never opened.
//
// Everything here is a guard, and each one exists because without it something
// specific goes wrong:
//
//   · The craft membership renews by subscription, and a subscription cycle IS
//     an invoice. Without the first guard every $29 renewal would open a
//     done-for-you engagement.
//   · A trialling membership's first invoice is $0 and Stripe marks it paid by
//     itself. Without the second, a free trial would open one too.
//   · Invoices raised by hand in the Stripe dashboard are a documented path
//     and carry whatever metadata a person typed, usually none. They pass
//     through in silence rather than filling the log with errors.
//
// There is deliberately NO order record. `ensureOrder` writes under
// `by-intent/`, which the stockroom ledger and the account scan both read
// blind and unfiltered — an invoice has no download entitlement, no receipt
// and no token, so a row there would be pollution. Idempotency instead rests
// on the reference, which is minted when the invoice is CREATED and lives in
// its metadata: every Stripe retry carries the same one, and the workspace
// holds `reference` as a primary key and answers a repeat with the engagement
// it already opened.
/**
 * The decision, pure: does this invoice open an engagement, and as what?
 *
 * Returns `{ reason }` for every invoice that should pass through untouched,
 * or `{ commission }` for one that should cross to the workspace. Separated
 * from the sending so the guards — which are the entire value of this branch —
 * are a thing that can be tested without a network, a Stripe, or a workspace.
 */
export function invoiceCommission(inv = {}) {
  const meta = inv.metadata || {}

  if (subscriptionInvoice(inv)) return { reason: 'subscription' }

  // `amount_paid` and not `total`: a fully discounted invoice is still nothing
  // collected, and an engagement is not opened on nothing collected.
  if (!(Number(inv.amount_paid) > 0)) return { reason: 'nothing-paid' }

  if (meta.kind !== 'service') return { reason: 'not-a-service' }

  const service = SERVICES[meta.service]
  if (!service) return { reason: 'unknown-service' }

  // The dedupe key. Without it a Stripe retry — and Stripe retries for days —
  // opens a second engagement for one payment, so a missing one is refused
  // loudly rather than papered over with a fresh reference.
  const reference = String(meta.reference || '').trim()
  if (!reference) return { reason: 'no-reference' }

  // `customers.create` in the billing desk sets `name: company || contact`, so
  // `customer_name` here may be the company. The person's name is carried in
  // the invoice's own metadata for exactly this reason.
  const name = String(meta.contact || inv.customer_name || '').trim()
  const email = String(meta.email || inv.customer_email || '').trim().toLowerCase()
  // The workspace rejects both outright, and a rejected commission sits in the
  // outbox being retried forever without ever being able to succeed.
  if (!name || !email) return { reason: 'incomplete' }

  const mode = meta.mode === 'deposit' ? 'deposit' : 'full'
  return {
    service: meta.service,
    reference,
    commission: commissionFromOrder({
      order: {
        reference,
        name,
        email,
        handle: '',
        platform: '',
        niche: '',
        joinCraft: false,
        currency: inv.currency || 'usd',
        amount: Number(inv.amount_paid) || 0,
        // Absent on a deposit invoice on purpose — the billing desk takes
        // free-text lines and does not know the whole fee, so the workspace
        // applies the house convention rather than a number we invented.
        fullAmount: Number(meta.fullAmount) > 0 ? Number(meta.fullAmount) : 0,
      },
      service,
      mode,
      // The invoice's own id, so the engagement's origin points at the thing
      // that was actually paid and a person can find it in Stripe.
      intent: { id: inv.id },
      answers: {},
      notes: [inv.number && `Invoice ${inv.number}`, inv.description].filter(Boolean).join('\n'),
    }),
  }
}

/** The sending, thin, around the decision above. */
export async function invoicePaid(inv) {
  const { reason, commission, reference, service } = invoiceCommission(inv)
  if (reason) {
    // Two of these are somebody's mistake and belong in the log; the rest are
    // the ordinary traffic this branch exists to ignore.
    if (reason === 'unknown-service' || reason === 'no-reference' || reason === 'incomplete') {
      console.error(`stripe-webhook: a service invoice refused — ${reason}`, inv?.id, inv?.number || '')
    }
    return Response.json({ received: true, handled: false, reason })
  }

  const sent = await deliverCommission(commission)

  if (sent.ok) {
    flushOutbox({ limit: 5 }).catch(() => {})
    console.log('stripe-webhook: invoice commissioned', { reference, service, invoice: inv.number || inv.id, engagement: sent.code || '' })
    return Response.json({ received: true, handled: true, engagement: sent.code || '' })
  }

  // Held. A 500 brings Stripe back — the cheapest retry there is — and the
  // outbox keeps the commission even if Stripe never returns.
  console.error('stripe-webhook: invoice commission HELD —', sent.error, reference)
  return Response.json({ error: 'Commission held' }, { status: sent.retry === false ? 200 : 500 })
}

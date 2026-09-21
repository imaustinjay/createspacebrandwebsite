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
import {
  signalItem, entitlementRow, eventTime, userByEmail, workspaceForUser,
  writeEntitlement, entitlementWritable,
} from '../shared/signal-entitlement.mjs'

const HANDLED = new Set([
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
  'setup_intent.succeeded',
  // The second door into a done-for-you engagement. Not every client is sent
  // to a checkout — some are invoiced, and an invoice that goes paid has to
  // reach the desk the same way a card does, or the one purchase path the
  // agency uses most is the one the automation never sees.
  'invoice.paid',
  // SIGNAL's paywall. These three are the ONLY thing that opens the product
  // to a subscriber and the only thing that closes it again, so a
  // subscription that changes state without one of these landing is a
  // creator either locked out of what they paid for or using what they
  // stopped paying for.
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
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

  // A SUBSCRIPTION changed. Handled apart from everything below for the
  // same reason invoice.paid is: the object is not a PaymentIntent, has a
  // different id space, and buys reach rather than files.
  if (event.type.startsWith('customer.subscription.')) return subscriptionChanged(event)

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

// ── A subscription, as reach into SIGNAL ──────────────────────────────────
//
// SIGNAL is a paid workspace and this is the door. Nothing else in either
// repo can open it: the table these write has no insert or update policy at
// all, so a creator session cannot set its own tier, period end or expiry.
//
// Every guard below exists because without it something specific goes wrong:
//
//   · The craft membership is a subscription too, and so is every future one
//     this account sells. Without the tier guard, a $29 craft renewal would
//     mint a SIGNAL workspace and hand over the product.
//   · The bundle sells SIGNAL pro under `tier: bundle`, which is not a tier
//     the matrix knows. Without `signal_tier`, a bundle subscriber pays $59
//     and reaches nothing.
//   · Stripe does not promise webhooks in order. Without the freshness check
//     a retried `updated` landing after a `deleted` reopens a cancelled
//     subscription.
//
// There is deliberately no event ledger. §13 asks that a replay change
// nothing, and the row is keyed on workspace — a replayed event rewrites
// identical values rather than stacking a second entitlement — so the shape
// of the table satisfies it without remembering every event id.
/**
 * The decision, pure: is this event SIGNAL's, and what should be written?
 *
 * Returns `{ reason }` for every subscription that should pass through
 * untouched, or `{ tier, row, eventAt, userId, customer }` for one that moves
 * the paywall. Separated from the writing so the guards — which are the whole
 * value of this branch — can be tested without a network, a Stripe, or a
 * Supabase.
 */
export function signalSubscription(event = {}) {
  const sub = event?.data?.object || {}
  if (!sub.id) return { reason: 'not-a-subscription' }

  // The craft, and anything else this account sells by subscription, is not
  // SIGNAL and must reach none of this.
  const matched = signalItem(sub)
  if (!matched) return { reason: 'not-signal' }
  const { tier, item } = matched

  // The matched item is passed through so the period comes from SIGNAL's own
  // line rather than whichever line happened to be first.
  const row = entitlementRow(sub, tier, item)
  // A SIGNAL price created without its tier metadata (§13 requires it). Loud
  // on the first test purchase rather than quiet at the first renewal.
  if (!row?.tier) return { reason: 'no-tier-metadata' }
  if (!row.status) return { reason: 'no-status' }

  return {
    tier,
    row,
    eventAt: eventTime(event),
    // Stamped at checkout when the buyer is signed in — the direct link, and
    // the only one that cannot be confused by a shared or changed address.
    userId: clean(sub.metadata?.cs_user || ''),
    customer: row.stripe_customer_id,
  }
}

export async function subscriptionChanged(event) {
  const decided = signalSubscription(event)
  if (decided.reason) {
    if (decided.reason === 'no-tier-metadata') {
      // Someone is paying for SIGNAL against a price that cannot say which
      // tier they bought. Nothing can be granted, and no retry fixes a
      // missing metadata field — so say it where it will be seen.
      console.error('stripe-webhook: a SIGNAL price with no tier metadata — see §13', {
        subscription: event?.data?.object?.id,
      })
    }
    return Response.json({ received: true, handled: false, reason: decided.reason })
  }

  if (!entitlementWritable()) {
    // A missing environment variable, not a blip: retrying for days changes
    // nothing. But a subscriber is now paying for something they cannot
    // reach, so this is an error and not a shrug.
    console.error('stripe-webhook: SIGNAL subscription with nowhere to write it — SUPABASE_SERVICE_ROLE_KEY missing', {
      subscription: decided.row.stripe_sub_id,
    })
    return Response.json({ received: true, handled: false, reason: 'not-configured' })
  }

  // Who bought it. The metadata link first; the customer's address only as a
  // fallback, because an address is a weaker claim on an account than an id.
  let userId = decided.userId
  if (!userId && decided.customer) {
    const stripe = stripeClient()
    if (!stripe) return Response.json({ received: true, handled: false, reason: 'not-configured' })
    try {
      const customer = await stripe.customers.retrieve(decided.customer)
      if (!customer?.deleted) userId = (await userByEmail(customer.email)) || ''
    } catch (err) {
      console.error('stripe-webhook: could not read the customer behind a SIGNAL subscription —', err?.message || err)
      return Response.json({ error: 'Customer unreadable' }, { status: 500 })
    }
  }

  if (!userId) {
    // Paid, with no account to attach it to. The worst outcome available
    // here, and no retry produces an account that does not exist — so it is
    // logged to be found and fixed by hand rather than swallowed.
    console.error('stripe-webhook: a SIGNAL subscription with no account behind it', {
      subscription: decided.row.stripe_sub_id,
      customer: decided.customer,
    })
    return Response.json({ received: true, handled: false, reason: 'no-account' })
  }

  const workspaceId = await workspaceForUser(userId, { name: '' })
  if (!workspaceId) {
    // Supabase was reachable enough to try and not enough to finish. A retry
    // is worth having.
    console.error('stripe-webhook: could not reach a workspace for a SIGNAL subscriber', { user: userId })
    return Response.json({ error: 'Workspace unavailable' }, { status: 500 })
  }

  const wrote = await writeEntitlement(workspaceId, decided.row, {
    eventAt: decided.eventAt,
    reason: event.type,
  })

  if (!wrote.ok) {
    console.error('stripe-webhook: SIGNAL entitlement NOT written —', wrote.reason, { workspace: workspaceId })
    return wrote.retry
      ? Response.json({ error: 'Entitlement write failed' }, { status: 500 })
      : Response.json({ received: true, handled: false, reason: wrote.reason })
  }

  console.log('stripe-webhook: SIGNAL entitlement written', {
    workspace: workspaceId,
    tier: decided.tier,
    status: decided.row.status,
    wrote: wrote.wrote !== false,
  })
  return Response.json({ received: true, handled: true, tier: decided.tier, stale: wrote.reason === 'stale-event' })
}

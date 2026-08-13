// POST /api/checkout — open a payment, without leaving the website.
//
// This used to hand the buyer to checkout.stripe.com. It doesn't any more: it
// returns a client secret, and the payment is taken by Stripe's Payment
// Element mounted inside /shop/checkout/, in the house's own type and colour.
// The buyer never sees another domain, and createspace still never sees a card
// number — the fields belong to Stripe, they just render here.
//
// The browser sends product ids and who the files are for. It does not send
// prices, and a price it did send would be ignored: every amount is resolved
// here, from Stripe, by id. That is what makes a cart held in localStorage
// safe to trust — the worst a tampered cart can do is buy something at its
// real price.
//
// Two shapes come out, because the shelf sells two kinds of thing:
//
//   payment — a PaymentIntent for a cart of one-time products.
//   setup   — a SetupIntent, when a membership starts on a trial and there is
//             genuinely nothing to charge today. Confirming it files the card
//             for the day the trial ends.
//
// Either way an order record is written here, keyed by the intent, before the
// buyer is asked for a card. The webhook doesn't need metadata archaeology
// later; it looks the order up by the intent that paid for it.
import { randomBytes } from 'node:crypto'
import { SHELF, clean, keyMismatch, resolvePrices, siteOrigin, stripeClient } from '../shared/catalog.mjs'
import { ensureOrder } from '../shared/storage.mjs'

const MAX_ITEMS = 6
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// Same shape of guard as the shop desk, a little looser: a person can
// legitimately reach the payment step several times in an hour, and being
// locked out mid-purchase is the most expensive error this file could make.
const WINDOW_MS = 60 * 60 * 1000
const MAX_PER_WINDOW = 20
const memoryHits = new Map()

async function overLimit(ip) {
  const now = Date.now()
  try {
    const { getStore } = await import('@netlify/blobs')
    const store = getStore('checkout-rate')
    const hits = ((await store.get(ip, { type: 'json' })) || []).filter((t) => now - t < WINDOW_MS)
    if (hits.length >= MAX_PER_WINDOW) return true
    hits.push(now)
    await store.setJSON(ip, hits)
    return false
  } catch {
    const hits = (memoryHits.get(ip) || []).filter((t) => now - t < WINDOW_MS)
    if (hits.length >= MAX_PER_WINDOW) return true
    hits.push(now)
    memoryHits.set(ip, hits)
    return false
  }
}

// No 0/O/1/I — this gets read aloud down a phone line often enough to matter.
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'
function reference() {
  const bytes = randomBytes(6)
  let tail = ''
  for (const b of bytes) tail += ALPHABET[b % ALPHABET.length]
  return `CS-${new Date().getUTCFullYear()}-${tail}`
}

// A client secret is `<intent id>_secret_<random>`. Stripe's newer invoice
// shape hands back the secret without the id beside it, and the id is what
// the order record is keyed by, so take it from the front of the secret —
// a documented, stable format rather than a guess.
function intentIdFrom(secret) {
  const at = String(secret || '').indexOf('_secret_')
  return at > 0 ? secret.slice(0, at) : ''
}

// The membership path. Stripe has moved where a subscription's first payment
// secret lives more than once, so read every shape it has had, newest first,
// and only give up when none of them is there.
async function subscriptionSecret(stripe, params, idempotencyKey) {
  let sub
  try {
    sub = await stripe.subscriptions.create(
      { ...params, expand: ['latest_invoice.confirmation_secret', 'pending_setup_intent'] },
      { idempotencyKey }
    )
  } catch (err) {
    // An older pinned API version doesn't know `confirmation_secret`. Ask for
    // what that version does know rather than failing the sale. A different
    // key, because Stripe would otherwise replay the first call's error.
    if (!/confirmation_secret/i.test(err?.message || '')) throw err
    sub = await stripe.subscriptions.create(
      { ...params, expand: ['latest_invoice.payment_intent', 'pending_setup_intent'] },
      { idempotencyKey: idempotencyKey + ':legacy' }
    )
  }

  const invoice = sub.latest_invoice && typeof sub.latest_invoice === 'object' ? sub.latest_invoice : null
  const pendingSetup = sub.pending_setup_intent && typeof sub.pending_setup_intent === 'object' ? sub.pending_setup_intent : null

  // A trial means the first invoice is nothing. There is no payment to
  // confirm, only a card to file, so hand back the setup intent and let the
  // page say "nothing due today" instead of asking for £0.
  if (pendingSetup?.client_secret) {
    return { secret: pendingSetup.client_secret, intentType: 'setup', dueToday: 0, subscription: sub }
  }

  const secret =
    invoice?.confirmation_secret?.client_secret ||
    (invoice?.payment_intent && typeof invoice.payment_intent === 'object' ? invoice.payment_intent.client_secret : '')

  if (!secret) throw new Error('subscription created without anything to confirm')
  return {
    secret,
    intentType: 'payment',
    dueToday: typeof invoice?.amount_due === 'number' ? invoice.amount_due : null,
    subscription: sub,
  }
}

export default async (req, context) => {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 })

  let body = {}
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'Bad request' }, { status: 400 })
  }

  // ------------------------------------------------------------- the cart
  const seen = new Set()
  const items = []
  for (const raw of Array.isArray(body.items) ? body.items : []) {
    const id = String(raw || '')
    if (!SHELF[id] || seen.has(id)) continue
    seen.add(id)
    items.push(id)
  }
  if (!items.length) {
    return Response.json({ error: 'Your cart is empty — add something first.' }, { status: 400 })
  }
  if (items.length > MAX_ITEMS) {
    return Response.json({ error: 'That’s more than the shelf holds.' }, { status: 400 })
  }

  // ---------------------------------------------------------- the details
  const email = String(body.email || '').trim().slice(0, 320)
  const name = String(body.name || '').trim().slice(0, 200)
  const handle = String(body.handle || '').trim().slice(0, 100)
  const joinCraft = body.joinCraft !== false

  if (!EMAIL_RE.test(email)) {
    return Response.json({ error: "That email doesn't look complete — that's where the files go." }, { status: 400 })
  }
  if (!name) {
    return Response.json({ error: 'Add a name for the receipt.' }, { status: 400 })
  }
  if (body.agreed !== true) {
    return Response.json({ error: 'Please accept the terms before we take payment.' }, { status: 400 })
  }

  const ip =
    context?.ip || req.headers.get('x-nf-client-connection-ip') || req.headers.get('x-forwarded-for') || 'unknown'
  if (await overLimit(ip)) {
    return Response.json(
      { error: "That's a few attempts in quick succession — give it a little while, or write to us and we'll take it from here." },
      { status: 429 }
    )
  }

  // ----------------------------------------------------------- the prices
  const stripe = stripeClient()
  const publishableKey = clean(process.env.STRIPE_PUBLISHABLE_KEY)
  const mismatch = keyMismatch()
  if (!stripe || !publishableKey || mismatch) {
    if (stripe && !publishableKey) {
      console.error('checkout: STRIPE_SECRET_KEY is set but STRIPE_PUBLISHABLE_KEY is missing — the payment form cannot load')
    }
    if (mismatch) {
      // Fail here rather than at Pay. Opening an intent with one mode's key
      // and handing the browser the other's produces a payment field that
      // cannot possibly succeed, and an error that talks about intents
      // instead of about the mix-up that caused it.
      console.error('checkout: REFUSING TO OPEN A PAYMENT —', mismatch)
    }
    return Response.json(
      {
        error: "Checkout isn't connected yet — nothing was charged. Write to us and we'll tell you the moment it opens.",
        reason: mismatch ? 'key-mismatch' : 'not-configured',
      },
      { status: 503 }
    )
  }

  let prices
  try {
    prices = await resolvePrices(stripe)
  } catch (err) {
    console.error('checkout: price read failed —', err?.message || err)
    return Response.json(
      { error: "We couldn't reach the payment desk just now — nothing was charged. Try again in a moment.", reason: 'unreachable' },
      { status: 502 }
    )
  }

  const missing = items.filter((id) => !prices[id])
  if (missing.length) {
    // A product on the shelf with no price behind it is a configuration
    // fault, not the buyer's — say so plainly and name it in the log.
    console.error('checkout: no Stripe price for', missing.join(', '))
    const names = missing.map((id) => SHELF[id].name).join(', ')
    return Response.json(
      {
        error: `${names} isn't on sale yet — nothing was charged. Everything else in your cart still is.`,
        reason: 'no-price',
        missing,
      },
      { status: 409 }
    )
  }

  const currencies = new Set(items.map((id) => prices[id].currency))
  if (currencies.size > 1) {
    console.error('checkout: mixed currencies in one cart —', [...currencies].join(', '))
    return Response.json(
      { error: 'Those items are priced in different currencies — buy them separately for now.', reason: 'mixed-currency' },
      { status: 409 }
    )
  }

  // ---------------------------------------------------------- the payment
  const currency = prices[items[0]].currency
  const subtotal = items.reduce((sum, id) => sum + prices[id].amount, 0)
  const membership = items.filter((id) => prices[id].recurring)
  const oneTime = items.filter((id) => !prices[id].recurring)
  const orderRef = reference()
  const origin = siteOrigin(req)

  const metadata = {
    reference: orderRef,
    cart: items.join(','),
    name: name.slice(0, 400),
    handle: handle.slice(0, 400),
    joinCraft: joinCraft ? 'yes' : 'no',
    source: 'createspacebrand.com/shop/checkout',
  }

  let secret = ''
  let intentType = 'payment'
  let dueToday = subtotal

  try {
    if (membership.length) {
      // A cart with a membership in it becomes a subscription; the one-time
      // products ride along on the first invoice as invoice items, so the
      // buyer pays once and gets everything.
      // Keyed on the order reference throughout: a network retry inside any
      // one of these calls can't leave a stray customer, a double invoice
      // item, or two subscriptions behind.
      const customer = await stripe.customers.create(
        { email, name, metadata },
        { idempotencyKey: `customer:${orderRef}` }
      )

      for (const id of oneTime) {
        await stripe.invoiceItems.create(
          {
            customer: customer.id,
            price: prices[id].priceId,
            quantity: 1,
            metadata: { reference: orderRef, item: id },
          },
          { idempotencyKey: `item:${orderRef}:${id}` }
        )
      }

      const params = {
        customer: customer.id,
        items: membership.map((id) => ({ price: prices[id].priceId, quantity: 1 })),
        payment_behavior: 'default_incomplete',
        payment_settings: {
          save_default_payment_method: 'on_subscription',
        },
        metadata,
      }

      const trialUntil = clean(process.env.STRIPE_CRAFT_TRIAL_UNTIL)
      if (trialUntil) {
        const at = Math.floor(new Date(trialUntil).getTime() / 1000)
        // "Nothing is charged before August 17" is a promise the page makes.
        // Honour it only while it's still in the future — a trial_end in the
        // past is an error, and a stale env var must not break checkout.
        if (isFinite(at) && at > Math.floor(Date.now() / 1000) + 60) params.trial_end = at
      }

      const out = await subscriptionSecret(stripe, params, `sub:${orderRef}`)
      secret = out.secret
      intentType = out.intentType
      dueToday = out.dueToday === null ? subtotal : out.dueToday
    } else {
      const intent = await stripe.paymentIntents.create(
        {
          amount: subtotal,
          currency,
          // Whatever the account has switched on — cards, wallets, Link —
          // decided in the Stripe dashboard rather than hardcoded here.
          automatic_payment_methods: { enabled: true },
          receipt_email: email,
          description: `createspace · ${items.map((id) => SHELF[id].name).join(', ')}`,
          metadata,
        },
        { idempotencyKey: `intent:${orderRef}` }
      )
      secret = intent.client_secret
      intentType = 'payment'
      dueToday = intent.amount
    }
  } catch (err) {
    // Stripe's own message is often the useful one (a deleted price, an
    // account not activated for live payments), so keep it in the private
    // log — and keep it out of the browser.
    console.error('checkout: could not open a payment —', err?.message || err)
    return Response.json(
      { error: "We couldn't open the payment form — nothing was charged. Give it a moment and try again." },
      { status: 502 }
    )
  }

  const intentId = intentIdFrom(secret)
  if (!intentId) {
    console.error('checkout: client secret in an unexpected shape')
    return Response.json(
      { error: "We couldn't open the payment form — nothing was charged. Give it a moment and try again." },
      { status: 502 }
    )
  }

  // Written before the card is asked for, so the webhook has somewhere to
  // deliver to the moment the payment lands, and the confirmation page has
  // something to read even if the webhook is slow.
  await ensureOrder(intentId, {
    reference: orderRef,
    email,
    name,
    handle,
    joinCraft,
    items,
    // Per-line amounts as they were at the moment of sale, so a receipt and a
    // confirmation page never have to re-derive a price that has since moved.
    lines: items.map((id) => ({ id, amount: prices[id].amount, recurring: Boolean(prices[id].recurring) })),
    currency,
    amount: dueToday,
    kind: membership.length ? 'membership' : 'one-time',
  })

  console.log('checkout: payment opened', {
    reference: orderRef,
    intent: intentId,
    intentType,
    items: items.join(','),
  })

  return Response.json(
    {
      ok: true,
      clientSecret: secret,
      intentType,
      publishableKey,
      reference: orderRef,
      currency,
      subtotal,
      dueToday,
      returnUrl: `${origin}/shop/order/`,
    },
    { headers: { 'Cache-Control': 'no-store' } }
  )
}

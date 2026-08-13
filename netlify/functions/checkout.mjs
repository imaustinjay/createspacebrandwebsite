// POST /api/checkout — turn a cart into a Stripe Checkout Session.
//
// The browser sends product ids and who the files are for. It does not send
// prices, and a price it did send would be ignored: every amount on the
// session is resolved here, from Stripe, by id. That is what makes a cart
// held in localStorage safe to trust — the worst a tampered cart can do is
// buy something at its real price.
//
// Card details never touch this site. They are typed on Stripe's own page,
// which is also where Apple Pay, Google Pay, Link, 3-D Secure and promotion
// codes come from for free. There is no card field anywhere in this repo.
import { randomBytes } from 'node:crypto'
import { SHELF, clean, resolvePrices, siteOrigin, stripeClient } from '../shared/catalog.mjs'

const MAX_ITEMS = 6
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// Same shape of guard as the shop desk, a little looser: a person can
// legitimately reach the payment page several times in an hour, and being
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
  if (!stripe) {
    return Response.json(
      {
        error: "Checkout isn't connected yet — nothing was charged. Write to us and we'll tell you the moment it opens.",
        reason: 'not-configured',
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

  // Currencies can't be mixed inside one session. If the shelf is ever
  // half-migrated, fail loudly here instead of at Stripe's door.
  const currencies = new Set(items.map((id) => prices[id].currency))
  if (currencies.size > 1) {
    console.error('checkout: mixed currencies in one cart —', [...currencies].join(', '))
    return Response.json(
      { error: 'Those items are priced in different currencies — buy them separately for now.', reason: 'mixed-currency' },
      { status: 409 }
    )
  }

  // ---------------------------------------------------------- the session
  const subscription = items.some((id) => prices[id].recurring)
  const origin = siteOrigin(req)
  const orderRef = reference()
  const autoTax = clean(process.env.STRIPE_AUTOMATIC_TAX).toLowerCase() === 'true'

  const metadata = {
    reference: orderRef,
    cart: items.join(','),
    name: name.slice(0, 400),
    handle: handle.slice(0, 400),
    joinCraft: joinCraft ? 'yes' : 'no',
    source: 'createspacebrand.com/shop/checkout',
  }

  const params = {
    mode: subscription ? 'subscription' : 'payment',
    line_items: items.map((id) => ({ price: prices[id].priceId, quantity: 1 })),
    // Stripe swaps the placeholder for the real id on the redirect back, and
    // /api/order is what turns it into a confirmation. Nothing about the
    // order is taken from the browser's word for it.
    success_url: `${origin}/shop/order/?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/shop/checkout/?canceled=1`,
    customer_email: email,
    client_reference_id: orderRef,
    allow_promotion_codes: true,
    metadata,
    // Digital delivery: no address is needed, and asking for one is friction
    // that costs sales. Stripe Tax needs one, so it's required only then.
    billing_address_collection: autoTax ? 'required' : 'auto',
  }

  if (autoTax) params.automatic_tax = { enabled: true }

  if (subscription) {
    // One-time prices are allowed alongside a recurring one — Stripe puts
    // them on the first invoice. The membership's own metadata travels with
    // the subscription so it's readable long after this session expires.
    params.subscription_data = { metadata }
    const trialUntil = clean(process.env.STRIPE_CRAFT_TRIAL_UNTIL)
    if (trialUntil) {
      const at = Math.floor(new Date(trialUntil).getTime() / 1000)
      // "Nothing is charged before August 17" is a promise the page makes.
      // Honour it only while it's still in the future — a trial_end in the
      // past is an error, and a stale env var must not break checkout.
      if (isFinite(at) && at > Math.floor(Date.now() / 1000) + 60) {
        params.subscription_data.trial_end = at
      }
    }
  } else {
    // A customer record per purchase, so a buyer who comes back — or asks
    // for a refund — is a person in Stripe rather than a loose charge.
    params.customer_creation = 'always'
    params.payment_intent_data = { metadata }
  }

  try {
    const sessionOptions = {
      // Two clicks on "Pay securely" must not become two Checkout Sessions.
      idempotencyKey: `checkout:${orderRef}`,
    }
    const session = await stripe.checkout.sessions.create(params, sessionOptions)
    if (!session.url) throw new Error('session created without a url')
    console.log('checkout: session created', {
      reference: orderRef,
      mode: params.mode,
      items: items.join(','),
      session: session.id,
    })
    return Response.json(
      { ok: true, url: session.url, reference: orderRef },
      { headers: { 'Cache-Control': 'no-store' } }
    )
  } catch (err) {
    // Stripe's own message is often the useful one (a deleted price, an
    // account not activated for live payments), so keep it in the private
    // log — and keep it out of the browser.
    console.error('checkout: session create failed —', err?.message || err)
    return Response.json(
      { error: "We couldn't open the payment page — nothing was charged. Give it a moment and try again." },
      { status: 502 }
    )
  }
}

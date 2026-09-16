// POST /api/service-checkout — buy a done-for-you service.
//
// The product checkout sells a cart of files. This sells ONE piece of work,
// which changes three things and nothing else:
//
//   · One service per payment. A cart of two builds is two engagements, two
//     intakes and two teams, and pretending otherwise at the till would just
//     move the confusion downstream.
//   · Two amounts per service — the full fee and the 50% deposit, each its own
//     Stripe price, because the catalog's terms are 50% on signature and 50%
//     on delivery. Never an amount this file computes.
//   · A few questions asked at the till. Not a substitute for the assessment
//     (that goes out the moment payment clears) — just the three facts that
//     make the welcome letter sound like it was written by someone who read
//     the order: their handle, their platform, their niche.
//
// The conventions are the product checkout's, deliberately: same rate-limit
// shape, same reference format, same "an order is written before the card is
// asked for", same refusal to trust a price from the browser. A person
// debugging both at 2am should find the same furniture in the same places.
import { randomBytes } from 'node:crypto'
import { clean, keyMismatch, siteOrigin, stripeClient } from '../shared/catalog.mjs'
import { SERVICES, isBuyable, resolveServicePrices, serviceLine } from '../shared/services.mjs'
import { ensureOrder } from '../shared/storage.mjs'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

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

// No 0/O/1/I — a reference gets read aloud down a phone line. Prefixed SVC so
// a service order is recognisable at a glance in the ledger and in Stripe.
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'
function reference() {
  const bytes = randomBytes(6)
  let tail = ''
  for (const b of bytes) tail += ALPHABET[b % ALPHABET.length]
  return `CS-SVC-${new Date().getUTCFullYear()}-${tail}`
}

const str = (v, max) => String(v ?? '').trim().slice(0, max)

export default async (req, context) => {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 })

  let body = {}
  try { body = await req.json() } catch { /* handled by the checks below */ }

  const id = str(body.service, 64)
  const mode = body.mode === 'deposit' ? 'deposit' : 'full'
  const service = SERVICES[id]

  if (!service) return Response.json({ error: "That isn't a service we sell." }, { status: 400 })
  if (!isBuyable(id)) {
    // Tier 04. Refused here rather than quietly priced, because the catalog's
    // rule — no payment link until the scope and the fee are agreed in writing
    // — is a promise the site makes on the page above this one.
    return Response.json(
      { error: `${service.name} is scoped in writing before any payment. Request the scope of work and we'll open it today.`, reason: 'scoped', scopeUrl: '/shop/services/#scope' },
      { status: 409 },
    )
  }

  const name = str(body.name, 120)
  const email = str(body.email, 200).toLowerCase()
  const handle = str(body.handle, 120).replace(/^@/, '')
  const platform = str(body.platform, 60)
  const niche = str(body.niche, 160)
  const notes = str(body.notes, 2000)

  if (!EMAIL_RE.test(email)) return Response.json({ error: "That email doesn't look complete — it's where everything goes." }, { status: 400 })
  if (!name) return Response.json({ error: 'Add your name so we know who we are building for.' }, { status: 400 })
  if (body.agreed !== true) return Response.json({ error: 'Please accept the terms before we take payment.' }, { status: 400 })

  const ip = context?.ip || req.headers.get('x-nf-client-connection-ip') || req.headers.get('x-forwarded-for') || 'unknown'
  if (await overLimit(ip)) {
    return Response.json({ error: "That's a few attempts in quick succession — give it a little while, or write to us and we'll take it from here." }, { status: 429 })
  }

  const stripe = stripeClient()
  const publishableKey = clean(process.env.STRIPE_PUBLISHABLE_KEY)
  const mismatch = keyMismatch()
  if (!stripe || !publishableKey || mismatch) {
    if (mismatch) console.error('service-checkout: REFUSING TO OPEN A PAYMENT —', mismatch)
    return Response.json(
      { error: "Checkout isn't connected yet — nothing was charged. Request the scope instead and we'll take it from there.", reason: mismatch ? 'key-mismatch' : 'not-configured' },
      { status: 503 },
    )
  }

  let prices
  try {
    prices = await resolveServicePrices(stripe)
  } catch (err) {
    console.error('service-checkout: price read failed —', err?.message || err)
    return Response.json({ error: "We couldn't reach the payment desk just now — nothing was charged. Try again in a moment.", reason: 'unreachable' }, { status: 502 })
  }

  const price = prices[id]?.[mode]
  if (!price) {
    // A service on the shelf with no price behind it is our fault, not the
    // buyer's, and the scope door is a real thing to offer them instead.
    console.error(`service-checkout: no Stripe price for ${id} (${mode}) — expected lookup key svc-${id}${mode === 'deposit' ? '-deposit' : ''}`)
    return Response.json(
      { error: `${service.name} isn't open for direct booking yet — nothing was charged. Request the scope and we'll open it today.`, reason: 'no-price', scopeUrl: '/shop/services/#scope' },
      { status: 409 },
    )
  }

  const orderRef = reference()
  const origin = siteOrigin(req)

  // Everything the commission will need, carried on the intent's metadata so
  // the webhook does not have to go archaeology-hunting for it. Stripe caps a
  // metadata value at 500 characters; `notes` is the only field that could
  // reach it, and it is cut here rather than rejected by Stripe mid-payment.
  const metadata = {
    reference: orderRef,
    kind: 'service',
    service: id,
    mode,
    name: name.slice(0, 400),
    handle: handle.slice(0, 400),
    platform: platform.slice(0, 200),
    niche: niche.slice(0, 400),
    notes: notes.slice(0, 480),
    source: 'createspacebrand.com/shop/services',
  }

  let intent
  try {
    intent = await stripe.paymentIntents.create(
      {
        amount: price.amount,
        currency: price.currency,
        receipt_email: email,
        description: serviceLine(id, mode),
        automatic_payment_methods: { enabled: true },
        metadata,
      },
      // Keyed on the reference: a network retry inside this call cannot leave
      // a second intent, and therefore cannot leave a second engagement.
      { idempotencyKey: `svc:${orderRef}` },
    )
  } catch (err) {
    console.error('service-checkout: intent failed —', err?.message || err)
    return Response.json({ error: "We couldn't open the payment — nothing was charged. Try again in a moment.", reason: 'intent-failed' }, { status: 502 })
  }

  // The order is written BEFORE the card is asked for, exactly as the product
  // checkout does it, so the webhook looks an order up by the intent that paid
  // for it rather than reconstructing one from metadata.
  const order = await ensureOrder(intent.id, {
    reference: orderRef,
    email,
    name,
    handle,
    platform,
    niche,
    notes,
    joinCraft: body.joinCraft === true,
    kind: 'service',
    service: id,
    mode,
    items: [],
    lines: [{ id, amount: price.amount, recurring: false }],
    currency: price.currency,
    amount: price.amount,
  })

  console.log('service-checkout: opened', { reference: orderRef, service: id, mode, intent: intent.id })

  return Response.json(
    {
      ok: true,
      clientSecret: intent.client_secret,
      publishableKey,
      reference: orderRef,
      service: { id, name: service.name, turnaround: service.turnaround },
      mode,
      currency: price.currency,
      amount: price.amount,
      display: price.display,
      // Where Stripe brings the buyer back to. It appends the intent and its
      // client secret, which /shop/order/ verifies before showing anything —
      // so this is a bare path, never one already carrying a query.
      returnUrl: `${origin}/shop/order/`,
      // And the permanent way back in, for the receipt and for later.
      orderUrl: `${origin}/shop/order/?token=${encodeURIComponent(order.token)}`,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}

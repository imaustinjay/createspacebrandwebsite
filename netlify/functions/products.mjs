// /api/products — the stockroom door.
//
// Where the digital products themselves are put, so that buying one delivers
// it. Everything here is behind a bearer token held in `ADMIN_TOKEN`: without
// that variable set the door is closed entirely rather than open by default,
// because an upload endpoint that guesses at authorisation is worse than one
// that admits it has none.
//
//   GET    /api/products                       what is in stock, per product
//   POST   /api/products?item=&name=&label=    upload — the body IS the file
//   POST   /api/products?resend=pi_…           send that order's receipt again
//   PUT    /api/products?item=                 set the external links (JSON)
//   DELETE /api/products?item=&name=           remove one file
//
// The upload is a raw body rather than multipart on purpose: no parser, no
// dependency, and a browser can send a File straight down it.
import { IDS, SHELF, clean, isFree, keyMismatch, keyMode, resolvePrices, siteOrigin, stripeClient } from '../shared/catalog.mjs'
import { deliverOrder } from '../shared/deliver.mjs'
import { mailbox } from '../shared/mail.mjs'
import {
  deliverableCount,
  manifest,
  manifests,
  orderByIntent,
  putFile,
  readableSize,
  recentOrders,
  removeFile,
  safeName,
  setLinks,
} from '../shared/storage.mjs'

// 40 MB. Netlify will stream a download of any size back out, but an upload
// arrives as one request body, and something far larger than this belongs
// behind an external link rather than in a function.
const MAX_UPLOAD = 40 * 1024 * 1024

const NO_STORE = { 'Cache-Control': 'no-store' }

function unauthorised() {
  return Response.json(
    { error: 'Not authorised.' },
    { status: 401, headers: { ...NO_STORE, 'WWW-Authenticate': 'Bearer' } }
  )
}

// Which of the shop's wires are actually connected. Booleans and a mode —
// never a key, never a fragment of one. Behind the same admin token as
// everything else here, because even "the webhook secret is unset" is
// something a stranger has no business knowing.
//
// This exists because setting the shop up means pasting five values into a
// dashboard nobody can see from here, and "did that take?" should be a page
// you look at rather than a purchase you risk.
async function wiring() {
  const secret = clean(process.env.STRIPE_SECRET_KEY)
  const stripe = stripeClient()
  // Free products need nothing from Stripe, so counting them here would say
  // "1 of 7 priced" about an account holding nothing at all — a number that
  // implies Stripe did something it didn't. This panel is about the wiring,
  // and a free product has none.
  const needsStripe = IDS.filter((id) => !isFree(id))
  let priced = 0
  let found = null
  if (stripe) {
    try {
      const resolved = await resolvePrices(stripe)
      priced = needsStripe.filter((id) => resolved[id]).length
    } catch (err) {
      console.error('products: price check failed —', err?.message || err)
      priced = -1 // reachable difference between "none priced" and "couldn't ask"
    }

    // "0 of 6 priced" is a true statement and a useless one: it can't tell
    // you whether the account is empty or whether six perfectly good prices
    // are sitting there without lookup keys. So when the shelf doesn't fully
    // resolve, go and look at what the account actually has, and show it.
    // Nothing here is secret — a price id is public by nature, and this is
    // behind the admin token regardless.
    if (priced < needsStripe.length) {
      try {
        const list = await stripe.prices.list({ active: true, limit: 30, expand: ['data.product'] })
        found = list.data.map((price) => ({
          id: price.id,
          lookupKey: price.lookup_key || null,
          // Whether this one is already claimed by a shelf id, so the panel
          // can show what's left over rather than what's already working.
          claimed: Boolean(price.lookup_key && SHELF[price.lookup_key]),
          name: (price.product && typeof price.product === 'object' && price.product.name) || 'Unnamed product',
          amount: typeof price.unit_amount === 'number' ? price.unit_amount : null,
          currency: price.currency,
          recurring: Boolean(price.recurring),
        }))
      } catch (err) {
        console.error('products: could not list the account’s prices —', err?.message || err)
      }
    }
  }
  const hooks = clean(process.env.STRIPE_WEBHOOK_SECRET).split(/[\s,]+/).filter(Boolean).length
  return {
    secretKey: Boolean(secret),
    publishableKey: Boolean(clean(process.env.STRIPE_PUBLISHABLE_KEY)),
    mode: keyMode(secret),
    publishableMode: keyMode(process.env.STRIPE_PUBLISHABLE_KEY),
    // A live secret paired with a test publishable key (or the reverse) is
    // the classic go-live slip, and it fails at the worst possible moment.
    keyMismatch: keyMismatch(),
    webhookSecret: hooks > 0,
    // More than one is normal and deliberate: test and live are separate
    // endpoints with separate secrets, and both can be held at once.
    webhookSecrets: hooks,
    mail: Boolean(mailbox()),
    priced,
    of: needsStripe.length,
    // What the account holds, when the shelf didn't fully resolve. null when
    // there was nothing to diagnose or Stripe couldn't be asked.
    found,
    // The ids the shelf is looking for, so the panel can name them exactly
    // rather than making the reader go and find them in a README. Free ones
    // are left out: there is no lookup key to set for something that costs
    // nothing, and listing it would send someone hunting for one.
    wanted: needsStripe,
  }
}

// The ledger: what has been bought, and what happened to it afterwards.
//
// One line per order, with the part that matters most on the end — whether
// the receipt was actually sent, and by which of the two doors. `by webhook`
// means Stripe called us and the wiring is right; `by order-page` means the
// webhook never arrived and the confirmation page had to cover for it. That
// difference is the whole diagnosis, and it should be readable at a glance
// rather than dug out of a function log in another dashboard.
async function ledger() {
  const orders = await recentOrders(25)
  return orders.map((o) => ({
    intentId: o.intentId,
    reference: o.reference || null,
    email: o.email || null,
    name: o.name || null,
    createdAt: o.createdAt || null,
    amount: typeof o.amount === 'number' ? o.amount : null,
    currency: o.currency || 'usd',
    kind: o.kind || 'one-time',
    items: (Array.isArray(o.items) ? o.items : []).map((id) => (SHELF[id] ? SHELF[id].name : id)),
    delivered: Boolean(o.delivered),
    deliveredAt: o.deliveredAt || null,
    // false when the mailbox wasn't configured — the one case where an order
    // is marked delivered and yet nobody was told anything.
    notified: o.notified !== false,
    filesSent: Boolean(o.filesSent),
    via: o.via || null,
  }))
}

// A constant-time-ish compare, so a wrong token can't be narrowed down by
// timing it. Node's timingSafeEqual needs equal lengths, hence the guard.
function sameToken(a, b) {
  if (!a || !b || a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export default async (req) => {
  const expected = clean(process.env.ADMIN_TOKEN)
  if (!expected || expected.length < 16) {
    console.error('products: ADMIN_TOKEN is unset or too short — the stockroom stays shut')
    return Response.json(
      { error: 'The stockroom is not set up. Set ADMIN_TOKEN (24+ random characters) and reload.', reason: 'not-configured' },
      { status: 503, headers: NO_STORE }
    )
  }

  const header = req.headers.get('authorization') || ''
  const offered = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
  if (!sameToken(offered, expected)) return unauthorised()

  const params = new URL(req.url).searchParams
  const item = params.get('item') || ''

  // --------------------------------------------------------- send it again
  // A receipt that didn't arrive is not a rare event — a mailbox that wasn't
  // configured yet, a spam folder, a buyer who typed one letter wrong. Every
  // one of those is fixable, and none of them should mean the owner writing
  // the email out by hand. This sends the real one, again.
  //
  // Ahead of the read, so that asking for it with the wrong verb is answered
  // as the mistake it is rather than quietly handed the product list.
  const resend = params.get('resend') || ''
  if (resend) {
    if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 })

    const order = await orderByIntent(resend)
    if (!order) {
      return Response.json({ error: 'No order with that id.' }, { status: 404, headers: NO_STORE })
    }
    if (!order.email) {
      return Response.json({ error: 'That order has no email address on it.' }, { status: 400, headers: NO_STORE })
    }

    const stripe = stripeClient()
    let intent = null
    // Only for the card line and Stripe's hosted copy — a receipt without
    // them is still a receipt, so a miss here doesn't stop the send.
    if (stripe && /^pi_/.test(resend)) {
      try {
        intent = await stripe.paymentIntents.retrieve(resend)
      } catch (err) {
        console.warn('products: could not re-read the intent for a resend —', err?.message || err)
      }
    }

    const result = await deliverOrder({
      order,
      intent,
      stripe,
      origin: siteOrigin(req),
      trialOnly: order.kind === 'membership' && !order.amount,
      via: 'stockroom',
      force: true,
    })

    if (!result.delivered) {
      const message =
        result.reason === 'send-failed'
          ? 'The mailbox refused it. Check MAIL_USER and MAIL_PASSWORD, then try again.'
          : 'That order could not be sent again.'
      return Response.json({ error: message, reason: result.reason }, { status: 502, headers: NO_STORE })
    }
    if (result.reason === 'no-mailbox') {
      return Response.json(
        { error: 'No mailbox is configured, so nothing was sent. Set MAIL_USER and MAIL_PASSWORD, redeploy, then try again.', reason: 'no-mailbox' },
        { status: 503, headers: NO_STORE }
      )
    }

    console.log('products: receipt re-sent', { reference: order.reference, to: order.email })
    return Response.json({ ok: true, sent: order.email, orders: await ledger() }, { headers: NO_STORE })
  }

  // ------------------------------------------------------------- read it
  if (req.method === 'GET') {
    const shelves = await manifests(IDS)
    const products = IDS.map((id) => ({
      id,
      name: SHELF[id].name,
      delivery: SHELF[id].delivery,
      files: (shelves[id].files || []).map((f) => ({ ...f, readable: readableSize(f.size) })),
      links: shelves[id].links || [],
      ready: deliverableCount(shelves[id]) > 0,
    }))
    return Response.json(
      { ok: true, products, maxUpload: MAX_UPLOAD, config: await wiring(), orders: await ledger() },
      { headers: NO_STORE }
    )
  }

  if (!SHELF[item]) {
    return Response.json({ error: 'Unknown product.' }, { status: 400, headers: NO_STORE })
  }

  // ----------------------------------------------------------- upload it
  if (req.method === 'POST') {
    const name = safeName(params.get('name') || '')
    if (!name) {
      return Response.json({ error: 'That filename has nothing usable in it.' }, { status: 400, headers: NO_STORE })
    }

    const declared = Number(req.headers.get('content-length') || 0)
    if (declared > MAX_UPLOAD) {
      return Response.json(
        { error: `That file is ${readableSize(declared)} — over the ${readableSize(MAX_UPLOAD)} upload ceiling. Add it as a link instead.` },
        { status: 413, headers: NO_STORE }
      )
    }

    let bytes
    try {
      bytes = new Uint8Array(await req.arrayBuffer())
    } catch (err) {
      console.error('products: upload body unreadable —', err?.message || err)
      return Response.json({ error: "That upload didn't arrive in one piece. Try it again." }, { status: 400, headers: NO_STORE })
    }
    if (!bytes.length) {
      return Response.json({ error: 'That file is empty.' }, { status: 400, headers: NO_STORE })
    }
    if (bytes.length > MAX_UPLOAD) {
      return Response.json(
        { error: `That file is ${readableSize(bytes.length)} — over the ${readableSize(MAX_UPLOAD)} upload ceiling. Add it as a link instead.` },
        { status: 413, headers: NO_STORE }
      )
    }

    const result = await putFile(item, name, bytes, {
      label: (params.get('label') || '').slice(0, 120) || name,
      contentType: req.headers.get('content-type') || 'application/octet-stream',
      size: bytes.length,
    })
    if (!result.ok) {
      return Response.json({ error: "Storage wouldn't take that just now. Try again in a moment." }, { status: 502, headers: NO_STORE })
    }

    console.log('products: uploaded', { item, name, size: bytes.length })
    return Response.json({ ok: true, file: result.file, shelf: await manifest(item) }, { headers: NO_STORE })
  }

  // ------------------------------------------------------------ link it
  if (req.method === 'PUT') {
    let body
    try {
      body = await req.json()
    } catch {
      return Response.json({ error: 'Bad request' }, { status: 400, headers: NO_STORE })
    }
    const links = (Array.isArray(body.links) ? body.links : [])
      .filter((l) => l && typeof l.url === 'string')
      // Only somewhere a browser can actually go, and only over TLS — these
      // land in a receipt, and a receipt is not a place to put an http:// link.
      .filter((l) => /^https:\/\//i.test(l.url.trim()))
      .slice(0, 12)
    const entry = await setLinks(item, links)
    console.log('products: links set', { item, count: entry.links.length })
    return Response.json({ ok: true, shelf: entry }, { headers: NO_STORE })
  }

  // ---------------------------------------------------------- remove it
  if (req.method === 'DELETE') {
    const name = safeName(params.get('name') || '')
    if (!name) {
      return Response.json({ error: 'Which file?' }, { status: 400, headers: NO_STORE })
    }
    await removeFile(item, name)
    console.log('products: removed', { item, name })
    return Response.json({ ok: true, shelf: await manifest(item) }, { headers: NO_STORE })
  }

  return new Response('Method Not Allowed', { status: 405 })
}

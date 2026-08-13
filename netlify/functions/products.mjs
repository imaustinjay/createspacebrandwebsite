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
//   PUT    /api/products?item=                 set the external links (JSON)
//   DELETE /api/products?item=&name=           remove one file
//
// The upload is a raw body rather than multipart on purpose: no parser, no
// dependency, and a browser can send a File straight down it.
import { IDS, SHELF, clean, resolvePrices, stripeClient } from '../shared/catalog.mjs'
import { mailbox } from '../shared/mail.mjs'
import {
  deliverableCount,
  manifest,
  manifests,
  putFile,
  readableSize,
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
  let priced = 0
  if (stripe) {
    try {
      priced = Object.keys(await resolvePrices(stripe)).length
    } catch (err) {
      console.error('products: price check failed —', err?.message || err)
      priced = -1 // reachable difference between "none priced" and "couldn't ask"
    }
  }
  const hooks = clean(process.env.STRIPE_WEBHOOK_SECRET).split(/[\s,]+/).filter(Boolean).length
  return {
    secretKey: Boolean(secret),
    publishableKey: Boolean(clean(process.env.STRIPE_PUBLISHABLE_KEY)),
    mode: secret.startsWith('sk_live') ? 'live' : secret.startsWith('sk_test') ? 'test' : null,
    webhookSecret: hooks > 0,
    // More than one is normal and deliberate: test and live are separate
    // endpoints with separate secrets, and both can be held at once.
    webhookSecrets: hooks,
    mail: Boolean(mailbox()),
    priced,
    of: IDS.length,
  }
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
      { ok: true, products, maxUpload: MAX_UPLOAD, config: await wiring() },
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

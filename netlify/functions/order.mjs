// GET /api/order?session_id=cs_… — read one order back, from Stripe.
//
// The confirmation page used to invent its own order out of sessionStorage:
// a random reference, no amount, and the same happy screen whether or not a
// payment had happened. This is the fix. The page now shows what Stripe says
// and nothing else, so "Payment confirmed" is a fact rather than a layout.
//
// The session id is the capability — it's unguessable, it's only ever handed
// to the person who just paid, and it's the standard Stripe pattern for a
// return page. Nothing here is retrievable without it.
import { SHELF, money, shelfIdForPrice, stripeClient } from '../shared/catalog.mjs'

const SESSION_RE = /^cs_(test_|live_)?[A-Za-z0-9]+$/
const NO_STORE = { 'Cache-Control': 'no-store' }

export default async (req) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return new Response('Method Not Allowed', { status: 405 })
  }

  const sessionId = new URL(req.url).searchParams.get('session_id') || ''
  if (!SESSION_RE.test(sessionId) || sessionId.length > 200) {
    return Response.json({ ok: false, reason: 'bad-session' }, { status: 400, headers: NO_STORE })
  }

  const stripe = stripeClient()
  if (!stripe) {
    return Response.json({ ok: false, reason: 'not-configured' }, { status: 503, headers: NO_STORE })
  }

  let session
  try {
    session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ['line_items'] })
  } catch (err) {
    const code = err?.statusCode === 404 || err?.code === 'resource_missing' ? 404 : 502
    if (code === 502) console.error('order: read failed —', err?.message || err)
    return Response.json(
      { ok: false, reason: code === 404 ? 'not-found' : 'unreachable' },
      { status: code, headers: NO_STORE }
    )
  }

  const paid = session.payment_status === 'paid' || session.payment_status === 'no_payment_required'
  // `complete` but unpaid means an asynchronous method (a bank debit) is
  // still clearing. It is neither a success to celebrate nor a failure to
  // apologise for, and the page has a state for exactly that.
  const state = paid ? 'paid' : session.status === 'complete' ? 'processing' : session.status === 'expired' ? 'expired' : 'open'

  const items = []
  for (const line of session.line_items?.data || []) {
    const id = shelfIdForPrice(line.price)
    const shelf = id ? SHELF[id] : null
    items.push({
      id,
      name: shelf ? shelf.name : line.description || 'Item',
      tier: shelf ? shelf.tier : '',
      delivery: shelf ? shelf.delivery : '',
      display: money(line.amount_total, session.currency),
    })
  }

  const meta = session.metadata || {}

  return Response.json(
    {
      ok: true,
      state,
      paid,
      reference: session.client_reference_id || meta.reference || null,
      email: session.customer_details?.email || session.customer_email || null,
      name: session.customer_details?.name || meta.name || null,
      joinCraft: meta.joinCraft !== 'no',
      subscription: session.mode === 'subscription',
      total: typeof session.amount_total === 'number' ? money(session.amount_total, session.currency) : null,
      currency: session.currency || null,
      items,
    },
    { headers: NO_STORE }
  )
}

// GET /api/catalog — what the shelf costs, read live from Stripe.
//
// The storefront ships every price as an em-dash and fills them in from here,
// which is why the design's own copy could always say "resolved from Stripe":
// now it is. Change a price in the Stripe dashboard and the site follows
// within five minutes, with no deploy and nothing to keep in sync.
//
// Unconfigured is not zero and not free — it stays an em-dash. The same rule
// the season doors follow: unknown is never rendered as an answer.
import { IDS, SHELF, resolvePrices, stripeClient } from '../shared/catalog.mjs'

const CACHE_OK = 'public, max-age=0, s-maxage=300, stale-while-revalidate=600'
const CACHE_FAIL = 'no-store'

export default async (req) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return new Response('Method Not Allowed', { status: 405 })
  }

  const stripe = stripeClient()
  if (!stripe) {
    return Response.json(
      { ok: false, reason: 'not-configured' },
      { headers: { 'Cache-Control': CACHE_FAIL } }
    )
  }

  let prices
  try {
    prices = await resolvePrices(stripe)
  } catch (err) {
    console.error('catalog: read failed —', err?.message || err)
    return Response.json(
      { ok: false, reason: 'unreachable' },
      { status: 502, headers: { 'Cache-Control': CACHE_FAIL } }
    )
  }

  const products = {}
  for (const id of IDS) {
    const price = prices[id]
    if (!price) continue
    // Only what a price tag needs. The Stripe price id stays server-side —
    // it isn't secret, but nothing on the page has any use for it, and a
    // browser that can't name a price can't be talked into buying one.
    products[id] = {
      amount: price.amount,
      currency: price.currency,
      display: price.display,
      recurring: price.recurring,
      name: SHELF[id].name,
    }
  }

  const found = Object.keys(products).length
  if (!found) {
    // Keys are set but nothing resolved: every price id is wrong, or none of
    // the prices carry a lookup key. Say which, in the private log.
    console.error('catalog: Stripe is connected but no shelf price resolved')
    return Response.json(
      { ok: false, reason: 'no-prices' },
      { headers: { 'Cache-Control': CACHE_FAIL } }
    )
  }

  return Response.json(
    { ok: true, products, resolved: found, of: IDS.length },
    { headers: { 'Cache-Control': CACHE_OK } }
  )
}

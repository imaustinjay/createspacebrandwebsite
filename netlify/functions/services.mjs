// GET /api/services — the done-for-you shelf, with live prices from Stripe.
//
// The sibling of /api/catalog, and the same promise: every price on the page
// is an em-dash until this answers, so a missing Stripe key shows NO price
// rather than a wrong one. A service comes back priced `null` until Stripe
// holds a price for it — which is the catalog's own rule kept honestly: no
// payment link until the scope and the fee are agreed in writing. Creating
// the price IS that agreement, written where the money comes from.
//
// Cached five minutes at the CDN, like the product catalog. A price change in
// Stripe is live on the site within five minutes without a deploy — and so is
// a service becoming bookable at all, because that is the same thing: give a
// price a lookup key and the row grows a button. A read Stripe did not answer
// is the one thing never cached: see shelfPayload.
import { stripeClient } from '../shared/catalog.mjs'
import { SERVICES, SERVICE_IDS, resolveServicePrices, bookable } from '../shared/services.mjs'
import { bridgeReady } from '../shared/commission.mjs'

/**
 * The shelf as the page receives it. Pure, so the two honest states can be
 * tested: `pricesLive` is true only when Stripe is configured AND every read
 * answered — a moment when it did not is sent with `no-store`, so an edge node
 * never holds "no prices" for five minutes and hands it to every phone that
 * asks. (That is exactly how a fixed-price build ends up reading "scoped in
 * writing" on one device and priced on another.) No key at all is a deliberate
 * state and caches normally: the page shows no price rather than a wrong one.
 */
export function shelfPayload(prices, { configured = false, errors = [], intakeLive = false } = {}) {
  const services = SERVICE_IDS.map((id) => {
    const s = SERVICES[id]
    return {
      id,
      name: s.name,
      tier: s.tier,
      turnaround: s.turnaround,
      blurb: s.blurb,
      delivers: s.delivers,
      // Whether it can be bought TODAY, which is whether Stripe holds a price
      // for it — not which tier the catalog files it under. A tier-04
      // engagement whose fee has been settled and given a lookup key sells
      // here; a tier-03 build whose price is missing falls back to the scope
      // door rather than showing a button that cannot charge.
      buyable: bookable(id, prices),
      price: prices[id]?.full || null,
      deposit: prices[id]?.deposit || null,
    }
  })
  const pricesLive = configured && errors.length === 0
  return {
    body: {
      services,
      // Not a secret, and genuinely useful on the page: when the bridge is
      // down there is no honest way to promise "your assessment arrives in
      // minutes", so the page says something truthful instead.
      intakeLive,
      stripeConfigured: configured,
      pricesLive,
    },
    headers: { 'cache-control': configured && !pricesLive ? 'no-store' : 'public, max-age=60, s-maxage=300' },
  }
}

export default async (req) => {
  if (req.method !== 'GET') return new Response('Method Not Allowed', { status: 405 })

  const stripe = stripeClient()
  const report = { errors: [] }
  const prices = await resolveServicePrices(stripe, report)
  const { body, headers } = shelfPayload(prices, { configured: Boolean(stripe), errors: report.errors, intakeLive: bridgeReady() })
  return Response.json(body, { headers })
}

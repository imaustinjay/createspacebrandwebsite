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
// price a lookup key and the row grows a button.
import { stripeClient } from '../shared/catalog.mjs'
import { SERVICES, SERVICE_IDS, resolveServicePrices, bookable } from '../shared/services.mjs'
import { bridgeReady } from '../shared/commission.mjs'

export default async (req) => {
  if (req.method !== 'GET') return new Response('Method Not Allowed', { status: 405 })

  const stripe = stripeClient()
  const prices = await resolveServicePrices(stripe)

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

  return Response.json(
    {
      services,
      // Not a secret, and genuinely useful on the page: when the bridge is
      // down there is no honest way to promise "your assessment arrives in
      // minutes", so the page says something truthful instead.
      intakeLive: bridgeReady(),
    },
    { headers: { 'cache-control': 'public, max-age=60, s-maxage=300' } },
  )
}

// GET /api/services — the done-for-you shelf, with live prices from Stripe.
//
// The sibling of /api/catalog, and the same promise: every price on the page
// is an em-dash until this answers, so a missing Stripe key shows NO price
// rather than a wrong one. Tier-04 services come back priced `null` on
// purpose — the catalog's rule is that no payment link exists until the scope
// and the fee are agreed in writing, and a figure on that row would be the
// site quietly breaking the house's own promise.
//
// Cached five minutes at the CDN, like the product catalog. A price change in
// Stripe is live on the site within five minutes without a deploy.
import { stripeClient } from '../shared/catalog.mjs'
import { SERVICES, SERVICE_IDS, resolveServicePrices } from '../shared/services.mjs'
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
      buyable: s.tier === '03',
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

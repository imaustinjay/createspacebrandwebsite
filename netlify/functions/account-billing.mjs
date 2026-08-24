// POST /api/account-billing — a door onto Stripe's billing portal.
//
// "Manage billing" in the account: update the card, download past invoices,
// pause or cancel the craft. All of that is Stripe's own hosted portal, which
// already does it correctly and keeps every card field off this site — this
// function only opens the door for the person actually signed in.
//
// Requires the account cookie and a confirmed address; the portal session is
// created for the Stripe customer carrying that address, so nobody can open
// anyone else's billing by guessing.
import { siteOrigin, stripeClient } from '../shared/catalog.mjs'
import { requireUser } from '../shared/customer-auth.mjs'

const NO_STORE = { 'Cache-Control': 'no-store' }

export default async (req) => {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 })

  const who = await requireUser(req)
  if (!who.ok) return Response.json({ ok: false, reason: 'signed-out' }, { status: 401, headers: NO_STORE })
  if (!who.user.confirmed) {
    return Response.json({ ok: false, reason: 'unconfirmed' }, { status: 403, headers: NO_STORE })
  }

  const stripe = stripeClient()
  if (!stripe) return Response.json({ ok: false, reason: 'not-configured' }, { status: 503, headers: NO_STORE })

  let customers
  try {
    ;({ data: customers } = await stripe.customers.list({ email: who.user.email.toLowerCase(), limit: 10 }))
  } catch (err) {
    console.error('account-billing: customer lookup failed —', err?.message || err)
    return Response.json({ ok: false, reason: 'unreachable' }, { status: 502, headers: NO_STORE })
  }

  // Prefer the customer that actually carries the subscription, so "manage
  // billing" opens on the membership rather than on an empty shell.
  let chosen = customers[0]
  for (const c of customers) {
    try {
      const { data } = await stripe.subscriptions.list({ customer: c.id, status: 'all', limit: 1 })
      if (data.length) {
        chosen = c
        break
      }
    } catch {
      // A failed read just means this one doesn't get preferred.
    }
  }
  if (!chosen) {
    return Response.json({ ok: false, reason: 'no-customer' }, { status: 404, headers: NO_STORE })
  }

  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: chosen.id,
      return_url: `${siteOrigin(req)}/account/`,
    })
    return Response.json({ ok: true, url: session.url }, { headers: NO_STORE })
  } catch (err) {
    // The commonest failure is the portal never having been configured in
    // the Stripe dashboard — a setup gap, and the page says so plainly.
    console.error('account-billing: portal session failed —', err?.message || err)
    return Response.json({ ok: false, reason: 'portal-unconfigured' }, { status: 502, headers: NO_STORE })
  }
}

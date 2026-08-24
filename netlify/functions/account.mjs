// GET /api/account — everything the portal shows, in one read.
//
// Behind the account cookie; 401 without it. What comes back is matched to
// the signed-in person by their **proven** email address:
//
//   purchases   the shop's own order records (Netlify Blobs), each with the
//               same permanent download links the receipt carries
//   membership  the craft — read live from Stripe subscriptions
//   invoices    brand billing — invoices raised to this address in Stripe,
//               each with Stripe's hosted page to pay it on
//
// The proof matters. Anyone can type any address into a signup form; only a
// confirmed one gets this far, because an unconfirmed address would let a
// stranger read — and download — somebody else's orders. Signed in but
// unconfirmed is answered honestly as its own state, never with data.
import { SHELF, money, stripeClient } from '../shared/catalog.mjs'
import { requireUser, accountCookie } from '../shared/customer-auth.mjs'
import { deliverableCount, manifests, recentOrders } from '../shared/storage.mjs'

const NO_STORE = { 'Cache-Control': 'no-store' }

export default async (req) => {
  if (req.method !== 'GET') return new Response('Method Not Allowed', { status: 405 })

  const who = await requireUser(req)
  if (!who.ok) {
    return Response.json({ ok: false, reason: 'signed-out' }, { status: 401, headers: NO_STORE })
  }

  const headers = { ...NO_STORE }
  if (who.setCookie) headers['Set-Cookie'] = accountCookie(who.setCookie, req)

  const user = who.user
  if (!user.confirmed) {
    return Response.json({ ok: true, user, confirmed: false }, { headers })
  }

  const email = user.email.toLowerCase()
  const stripe = stripeClient()

  const [purchases, billing] = await Promise.all([ownedOrders(email), stripeSide(stripe, email)])

  return Response.json(
    {
      ok: true,
      confirmed: true,
      user,
      purchases,
      membership: billing.membership,
      invoices: billing.invoices,
      // Whether "Manage billing" can do anything — true only when Stripe
      // knows this address as a customer.
      billable: billing.billable,
    },
    { headers }
  )
}

// ------------------------------------------------------------- purchases
//
// The order store is keyed by intent and by token — there is no by-email
// index, and Blobs has no way to query one. So this is a scan, the same scan
// the stockroom's ledger already does, filtered to this address. At this
// shop's scale that is a handful of small reads; the day it isn't, the fix
// is an index written at order time, not a bigger scan.
//
// Only delivered orders appear. An undelivered record is either a checkout
// somebody abandoned before paying (not a purchase) or a payment the webhook
// hasn't caught up with (the confirmation page delivers those on sight) —
// neither is something to hand download links out for.
async function ownedOrders(email) {
  const records = await recentOrders(500)
  const mine = records.filter(
    (r) => r.delivered && String(r.email || '').toLowerCase() === email
  )

  const ids = [...new Set(mine.flatMap((r) => (Array.isArray(r.items) ? r.items : [])))]
  const shelves = await manifests(ids)

  return mine.map((record) => ({
    reference: record.reference || null,
    placedAt: record.createdAt || null,
    total:
      record.kind === 'free' || record.amount === 0
        ? 'Free'
        : typeof record.amount === 'number'
          ? money(record.amount, record.currency)
          : null,
    kind: record.kind || 'one-time',
    // The same permanent door the receipt carries — the order page renders
    // the downloads themselves, so nothing is duplicated here.
    permalink: record.token ? `/shop/order/?token=${encodeURIComponent(record.token)}` : null,
    items: (Array.isArray(record.items) ? record.items : []).map((id) => ({
      id,
      name: SHELF[id] ? SHELF[id].name : id,
      tier: SHELF[id] ? SHELF[id].tier : '',
      ready: deliverableCount(shelves[id]) > 0,
    })),
  }))
}

// ------------------------------------------------------- the Stripe side
//
// Membership and invoices both hang off "which Stripe customers carry this
// address". The checkout creates one for every membership; the agency creates
// one by hand when it raises a brand's first invoice. Either way the address
// is the join, and it is a proven one by the time this runs.
async function stripeSide(stripe, email) {
  const none = { membership: null, invoices: [], billable: false }
  if (!stripe) return none

  let customers
  try {
    ;({ data: customers } = await stripe.customers.list({ email, limit: 10 }))
  } catch (err) {
    console.error('account: customer lookup failed —', err?.message || err)
    return none
  }
  if (!customers.length) return none

  const [subLists, invLists] = await Promise.all([
    Promise.all(
      customers.map((c) =>
        stripe.subscriptions
          .list({ customer: c.id, status: 'all', limit: 10 })
          .then((r) => r.data)
          .catch((err) => {
            console.error('account: subscription read failed —', err?.message || err)
            return []
          })
      )
    ),
    Promise.all(
      customers.map((c) =>
        stripe.invoices
          .list({ customer: c.id, limit: 25 })
          .then((r) => r.data)
          .catch((err) => {
            console.error('account: invoice read failed —', err?.message || err)
            return []
          })
      )
    ),
  ])

  // The craft is the only subscription the shop sells; the newest one that
  // isn't merely a closed chapter is the one worth showing.
  const subs = subLists
    .flat()
    .filter((s) => s.status !== 'incomplete' && s.status !== 'incomplete_expired')
    .sort((a, b) => (b.created || 0) - (a.created || 0))
  const sub = subs[0] || null

  const membership = sub
    ? {
        status: sub.status, // trialing · active · past_due · canceled · unpaid · paused
        endsAt: sub.cancel_at_period_end ? isoOf(sub.current_period_end) : null,
        renewsAt: !sub.cancel_at_period_end && sub.status === 'active' ? isoOf(sub.current_period_end) : null,
        trialEndsAt: sub.status === 'trialing' ? isoOf(sub.trial_end) : null,
      }
    : null

  // Subscription cycle invoices belong under "membership", not "billing" —
  // showing a brand's negotiated invoice next to a $29 renewal helps nobody.
  // A brand invoice is one raised by hand: no subscription behind it.
  const invoices = invLists
    .flat()
    .filter((inv) => !inv.subscription && inv.status !== 'draft' && inv.status !== 'void')
    .sort((a, b) => (b.created || 0) - (a.created || 0))
    .map((inv) => ({
      number: inv.number || inv.id,
      status: inv.status, // open · paid · uncollectible
      total: money(inv.total, inv.currency),
      issuedAt: isoOf(inv.created),
      dueAt: isoOf(inv.due_date),
      // Stripe's hosted invoice page — where an open one is actually paid.
      // Card details stay on Stripe's page, exactly as the checkout promises.
      href: inv.hosted_invoice_url || null,
      pdf: inv.invoice_pdf || null,
    }))

  return { membership, invoices, billable: true }
}

function isoOf(unix) {
  return typeof unix === 'number' && unix > 0 ? new Date(unix * 1000).toISOString() : null
}

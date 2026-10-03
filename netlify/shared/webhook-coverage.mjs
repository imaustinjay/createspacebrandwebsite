// Does the webhook Stripe holds for this site actually send the events this
// site handles?
//
// `STRIPE_WEBHOOK_SECRET` being set proves a secret was pasted. It proves
// nothing about which events the endpoint in Stripe's dashboard is subscribed
// to — and that is a list a person ticks by hand, once, usually before the
// site learned to handle a new one. `invoice.paid` is the case this was
// written for: it is the one event that turns a paid agency invoice into an
// engagement, it was added to the webhook after the endpoint was first
// created, and an endpoint that does not send it fails in the quietest way
// there is — the invoice is paid, the client is waiting, and nothing arrives
// to say so. The wiring panel asks Stripe for the endpoint and reads the
// list back, so "is invoice.paid ticked?" is a row you look at rather than a
// payment you find out from.
//
// Pure: the endpoints come from `stripe.webhookEndpoints.list()`, and the
// decision is made here where it can be tested.

/** The events this site's webhook does something with. Kept in step with
    HANDLED in netlify/functions/stripe-webhook.mjs. */
export const WANTED_EVENTS = Object.freeze([
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
  'setup_intent.succeeded',
  'invoice.paid',
])

/** The path the site's webhook answers on, as netlify.toml routes it. */
export const WEBHOOK_PATH = '/api/stripe-webhook'

/**
 * Read Stripe's endpoints against what this site needs.
 *
 * Returns
 *   { endpoints, ours, missing, invoicePaid }
 *   · endpoints   — how many the account holds (in this mode) at all
 *   · ours        — how many point at this site's webhook path and are enabled
 *   · missing     — the wanted events that NO enabled endpoint of ours sends
 *   · invoicePaid — true when some enabled endpoint of ours sends it, false
 *                   when ours exist and none does, null when none of ours were
 *                   found (nothing to say either way)
 *
 * An endpoint subscribed to `*` sends everything, and counts as sending each.
 * `origin` narrows "ours" to this deploy's own host when given; without it any
 * endpoint on the webhook path counts, which is right for a panel that only
 * wants to know whether the event is ticked somewhere.
 */
export function webhookCoverage(endpoints = [], { origin = '' } = {}) {
  const list = Array.isArray(endpoints) ? endpoints : []
  const host = hostOf(origin)
  const ours = list.filter((e) => {
    if (!e || e.status === 'disabled') return false
    const url = String(e.url || '')
    if (!url.includes(WEBHOOK_PATH)) return false
    return host ? hostOf(url) === host : true
  })
  const sends = new Set()
  for (const e of ours) {
    const events = Array.isArray(e.enabled_events) ? e.enabled_events : []
    if (events.includes('*')) WANTED_EVENTS.forEach((w) => sends.add(w))
    else events.forEach((ev) => sends.add(ev))
  }
  const missing = ours.length ? WANTED_EVENTS.filter((w) => !sends.has(w)) : [...WANTED_EVENTS]
  return {
    endpoints: list.length,
    ours: ours.length,
    missing,
    invoicePaid: ours.length ? sends.has('invoice.paid') : null,
  }
}

function hostOf(url) {
  try {
    return new URL(String(url || '')).hostname.toLowerCase()
  } catch {
    return ''
  }
}

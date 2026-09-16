// The second door: a paid invoice becoming an engagement, and the four things
// that must never come through it.
//
// Not every client is sent to a checkout. Some are invoiced — which used to
// mean the desk never heard about the sale at all, because `invoice.paid` was
// not a handled event and every one of them returned 2xx-and-do-nothing.
//
// The danger in fixing that is the opposite mistake. The craft membership
// renews by subscription and a subscription cycle IS an invoice; a trialling
// membership's first invoice is $0 and Stripe marks it paid by itself; and
// invoices raised by hand in the Stripe dashboard carry whatever metadata a
// person typed, usually none. Each of those must pass through untouched.
//
// These live in tests/ rather than beside the function they cover, because
// `netlify.toml` sets `functions = "netlify/functions"` and Netlify deploys
// every top-level module in that directory as an endpoint — a file left there
// would be published at /.netlify/functions/<name>.test and run on request.
// The shared/ tests are colocated safely for exactly the same reason: that
// directory is deliberately outside the one Netlify scans.
import test from 'node:test'
import assert from 'node:assert/strict'
import { invoiceCommission } from '../netlify/functions/stripe-webhook.mjs'
import { subscriptionInvoice } from '../netlify/shared/catalog.mjs'

/** A paid agency invoice, tagged with a service by the billing desk. */
const serviceInvoice = (over = {}) => ({
  id: 'in_1Abc2Def3Ghi',
  number: 'CS-0042',
  object: 'invoice',
  parent: null,
  amount_paid: 450000,
  currency: 'usd',
  customer_email: 'brand@example.com',
  customer_name: 'Example Studio LLC',
  description: 'Brand architecture, phase one',
  metadata: {
    kind: 'service',
    service: 'brand-architecture',
    mode: 'full',
    reference: 'CS-SVC-2026-K7M2PQ',
    contact: 'Dana Reyes',
    email: 'brand@example.com',
    fullAmount: '450000',
    source: 'billing-desk',
  },
  ...over,
})

/* ── which invoices were born of a subscription ──────────────────────────── */

test('the craft’s renewals are recognised on the API version we actually send', () => {
  // Stripe 22.x pins 2026-07-29.dahlia, where an Invoice has no top-level
  // `subscription` — it has `parent`. `!inv.subscription` was a filter that
  // filtered nothing, and every $29 renewal sat in the billing desk next to a
  // $4,500 engagement.
  assert.equal(subscriptionInvoice({ parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_1' } } }), true)
  assert.equal(subscriptionInvoice({ parent: { type: 'quote_details', quote_details: { quote: 'qt_1' }, subscription_details: null } }), false)
  assert.equal(subscriptionInvoice({ parent: null }), false)
})

test('an older webhook endpoint’s shape is still understood', () => {
  // A LIST call comes back at the version the library pins, but a WEBHOOK
  // payload is rendered at the version set on the endpoint in the dashboard,
  // which can be older than the library. Both shapes, one answer.
  assert.equal(subscriptionInvoice({ subscription: 'sub_1' }), true)
  assert.equal(subscriptionInvoice({ subscription: null }), false)
  assert.equal(subscriptionInvoice({}), false)
  assert.equal(subscriptionInvoice(null), false)
})

/* ── what must not open an engagement ────────────────────────────────────── */

test('a craft membership renewal is left entirely alone', () => {
  const out = invoiceCommission({
    ...serviceInvoice(),
    parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_craft' } },
  })
  assert.deepEqual(out, { reason: 'subscription' })
})

test('a $0 invoice opens nothing — a trial is not a purchase', () => {
  // Stripe finalizes and pays a zero-amount invoice by itself, so a trialling
  // membership produces a real invoice.paid with nothing collected.
  for (const amount_paid of [0, undefined, null, -1]) {
    assert.equal(invoiceCommission(serviceInvoice({ amount_paid })).reason, 'nothing-paid', String(amount_paid))
  }
})

test('an ordinary invoice passes through in silence', () => {
  // Raised by hand at the billing desk with no service picked, or raised in
  // the Stripe dashboard with no metadata at all. Neither is an error.
  assert.deepEqual(invoiceCommission(serviceInvoice({ metadata: {} })), { reason: 'not-a-service' })
  assert.deepEqual(invoiceCommission({ id: 'in_x', amount_paid: 12000 }), { reason: 'not-a-service' })
  // Called with nothing at all it still answers rather than throwing — a
  // webhook that throws is a 502 and a Stripe retry storm. It stops at the
  // earlier guard, which is the right one: nothing was paid.
  assert.deepEqual(invoiceCommission(), { reason: 'nothing-paid' })
})

test('a service we do not sell is refused rather than guessed at', () => {
  const meta = { ...serviceInvoice().metadata, service: 'moon-landing' }
  assert.equal(invoiceCommission(serviceInvoice({ metadata: meta })).reason, 'unknown-service')
})

test('no reference means no dedupe key, and that is refused', () => {
  // Stripe retries a webhook for days. The reference is the only thing that
  // makes a retry find the engagement it already opened instead of opening a
  // second one, so a missing reference is a refusal, never a fresh mint.
  const meta = { ...serviceInvoice().metadata, reference: '' }
  assert.equal(invoiceCommission(serviceInvoice({ metadata: meta })).reason, 'no-reference')
})

test('a buyer with no name or no email is stopped here, not in the outbox', () => {
  // The workspace rejects both outright with a 422, and a 422'd commission is
  // retried forever without ever being able to succeed.
  const meta = serviceInvoice().metadata
  assert.equal(invoiceCommission(serviceInvoice({ customer_name: '', metadata: { ...meta, contact: '' } })).reason, 'incomplete')
  assert.equal(invoiceCommission(serviceInvoice({ customer_email: '', metadata: { ...meta, email: '' } })).reason, 'incomplete')
})

/* ── and what a real one becomes ─────────────────────────────────────────── */

test('a paid service invoice becomes the commission the workspace expects', () => {
  const { commission, reference, service } = invoiceCommission(serviceInvoice())
  assert.equal(reference, 'CS-SVC-2026-K7M2PQ')
  assert.equal(service, 'brand-architecture')
  assert.equal(commission.reference, 'CS-SVC-2026-K7M2PQ')
  assert.equal(commission.kind, 'purchase')
  assert.equal(commission.payment, 'full')
  assert.equal(commission.amount, 450000, 'what was actually collected')
  assert.equal(commission.fullAmount, 450000)
  assert.equal(commission.currency, 'usd')
  assert.equal(commission.origin, 'stripe:in_1Abc2Def3Ghi', 'points at the invoice, findable in Stripe')
  assert.match(commission.notes, /CS-0042/)
  assert.equal(commission.client.member, false)
  // Every hard rejection in the workspace's readCommission, satisfied.
  assert.ok(commission.reference && commission.serviceKey && commission.client.name)
  assert.match(commission.client.email, /^[^\s@]+@[^\s@]+\.[^\s@]+$/)
  assert.ok(commission.amount > 0)
})

test('the person’s name beats the company on the Stripe customer', () => {
  // The billing desk creates customers as `name: company || contact`, so
  // `customer_name` on the event is often the company. An engagement is
  // addressed to a person, so the contact carried in invoice metadata wins.
  const { commission } = invoiceCommission(serviceInvoice())
  assert.equal(commission.client.name, 'Dana Reyes')
  assert.notEqual(commission.client.name, 'Example Studio LLC')

  // With no contact in metadata it falls back rather than refusing.
  const meta = { ...serviceInvoice().metadata, contact: '' }
  assert.equal(invoiceCommission(serviceInvoice({ metadata: meta })).commission.client.name, 'Example Studio LLC')
})

test('a deposit invoice does not invent the whole fee', () => {
  // The billing desk takes free-text lines and cannot know the full fee, so it
  // sends no fullAmount and the workspace applies the house convention. An
  // invented number here opens the engagement at the wrong value on a
  // financial record nobody would think to check.
  const meta = { ...serviceInvoice().metadata, mode: 'deposit' }
  delete meta.fullAmount
  const { commission } = invoiceCommission(serviceInvoice({ amount_paid: 225000, metadata: meta }))
  assert.equal(commission.payment, 'deposit')
  assert.equal(commission.amount, 225000)
  assert.equal(commission.fullAmount, 0, 'stated as unknown rather than guessed')
})

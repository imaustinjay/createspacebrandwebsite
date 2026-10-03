// The paid invoice that opened nothing, and the two things that now happen to
// it: the desk is told, and the desk can open it by hand.
//
// The decision itself (`invoiceCommission`) is covered in
// tests/stripe-webhook.test.mjs, where it grew up. This file covers what was
// added around it for the invoice that got through the guards without an
// engagement — the tag the billing desk writes after the fact, the ledger's
// reading of a tag, and the notice that replaces silence.
import test from 'node:test'
import assert from 'node:assert/strict'
import { invoiceCommission, retagMetadata, serviceTag, untaggedPaidNotice, heldInvoiceNotice, REFUSED_LOUDLY } from './invoice-commission.mjs'
import { isServiceReference } from './services.mjs'

/** A paid invoice raised with no service picked — or in the Stripe dashboard. */
const plainPaid = (over = {}) => ({
  id: 'in_1Natalie000000',
  number: 'CS-0051',
  object: 'invoice',
  status: 'paid',
  parent: null,
  amount_paid: 180000,
  currency: 'usd',
  customer_email: 'natalie@example.com',
  customer_name: 'Natalie Phoon',
  description: 'Brand direction, October',
  hosted_invoice_url: 'https://invoice.stripe.com/i/acct_x/test_x',
  metadata: {},
  ...over,
})

const BYTES = Buffer.from([1, 2, 3, 4, 5, 6])

/* ── what the ledger reads off an invoice ────────────────────────────────── */

test('an ordinary invoice has no tag, and a tagged one reads back whole', () => {
  assert.equal(serviceTag(plainPaid()), null)
  assert.equal(serviceTag({}), null)
  const tag = serviceTag(plainPaid({ metadata: { kind: 'service', service: 'brand-architecture', mode: 'deposit', reference: 'CS-SVC-2026-K7M2PQ' } }))
  assert.deepEqual(tag, { id: 'brand-architecture', name: 'Personal Brand Architecture', known: true, mode: 'deposit', reference: 'CS-SVC-2026-K7M2PQ' })
})

test('a tag naming a service we do not sell is shown as the typo it is', () => {
  const tag = serviceTag(plainPaid({ metadata: { kind: 'service', service: 'moon-landing', reference: 'CS-SVC-2026-K7M2PQ' } }))
  assert.equal(tag.known, false)
  assert.equal(tag.id, 'moon-landing')
  assert.equal(tag.mode, 'full', 'an unreadable mode is read as full, never as nothing')
})

/* ── tagging after the fact ──────────────────────────────────────────────── */

test('a paid, untagged invoice is tagged exactly as issue would have tagged it', () => {
  const out = retagMetadata(plainPaid(), { service: 'social-strategy-sprint', mode: 'full', bytes: BYTES, year: 2026 })
  assert.ok(!out.error, out.error)
  const m = out.metadata
  assert.equal(m.kind, 'service')
  assert.equal(m.service, 'social-strategy-sprint')
  assert.equal(m.mode, 'full')
  assert.ok(isServiceReference(m.reference), m.reference)
  assert.equal(m.contact, 'Natalie Phoon', 'the customer’s name, when the desk types none')
  assert.equal(m.email, 'natalie@example.com')
  assert.equal(m.fullAmount, '180000', 'a full invoice’s total IS the fee')
  assert.equal(m.source, 'billing-desk')
  assert.match(m.taggedAfterPaid, /^\d{4}-\d{2}-\d{2}$/, 'the honest record that this was added after payment')
  assert.equal(out.reference, m.reference)
})

test('what the tag writes is what the webhook’s decision then opens', () => {
  // The whole point: the same decision function, fed the retagged invoice,
  // produces a commission — not a reason.
  const inv = plainPaid()
  const { metadata } = retagMetadata(inv, { service: 'social-strategy-sprint', mode: 'full', bytes: BYTES, year: 2026 })
  const out = invoiceCommission({ ...inv, metadata })
  assert.ok(out.commission, out.reason)
  assert.equal(out.service, 'social-strategy-sprint')
  assert.equal(out.commission.client.name, 'Natalie Phoon')
  assert.equal(out.commission.client.email, 'natalie@example.com')
  assert.equal(out.commission.amount, 180000)
  assert.equal(out.commission.fullAmount, 180000)
  assert.equal(out.commission.payment, 'full')
  assert.equal(out.commission.origin, 'stripe:in_1Natalie000000')
  assert.match(out.commission.notes, /CS-0051/)
})

test('a deposit tagged after the fact does not invent the whole fee', () => {
  const { metadata } = retagMetadata(plainPaid({ amount_paid: 90000 }), { service: 'brand-architecture', mode: 'deposit', bytes: BYTES, year: 2026 })
  assert.equal(metadata.mode, 'deposit')
  assert.equal(metadata.fullAmount, undefined)
  const { commission } = invoiceCommission({ ...plainPaid({ amount_paid: 90000 }), metadata })
  assert.equal(commission.payment, 'deposit')
  assert.equal(commission.fullAmount, 0, 'left to the workspace’s convention')
})

test('a pasted reference continues the engagement; a wrong one is refused', () => {
  const ok = retagMetadata(plainPaid(), { service: 'brand-architecture', reference: 'cs-svc-2026-k7m2pq', bytes: BYTES, year: 2026 })
  assert.equal(ok.metadata.reference, 'CS-SVC-2026-K7M2PQ', 'upper-cased, as the desk files it')
  assert.match(retagMetadata(plainPaid(), { service: 'brand-architecture', reference: 'CS-SVC-2026-K7M2P', bytes: BYTES, year: 2026 }).error, /not one of ours/)
})

test('the desk’s typed contact beats the customer’s name on the invoice', () => {
  // A dashboard-raised invoice often has the company where the person goes.
  const inv = plainPaid({ customer_name: 'Phoon Studio Pte Ltd' })
  assert.equal(retagMetadata(inv, { service: 'brand-architecture', contact: 'Natalie Phoon', bytes: BYTES, year: 2026 }).metadata.contact, 'Natalie Phoon')
  assert.equal(retagMetadata(inv, { service: 'brand-architecture', bytes: BYTES, year: 2026 }).metadata.contact, 'Phoon Studio Pte Ltd')
})

test('what is already on the invoice survives the tag', () => {
  const inv = plainPaid({ metadata: { campaign: 'october' } })
  const { metadata } = retagMetadata(inv, { service: 'brand-architecture', bytes: BYTES, year: 2026 })
  assert.equal(metadata.campaign, 'october')
})

test('the three refusals, each a sentence a person can act on', () => {
  assert.match(retagMetadata(plainPaid(), { bytes: BYTES, year: 2026 }).error, /Pick the service/)
  assert.match(retagMetadata(plainPaid(), { service: 'moon-landing', bytes: BYTES, year: 2026 }).error, /not a service we offer/)
  assert.match(retagMetadata(plainPaid({ customer_name: '' }), { service: 'brand-architecture', bytes: BYTES, year: 2026 }).error, /no name/)
  assert.match(retagMetadata(plainPaid({ customer_email: '' }), { service: 'brand-architecture', bytes: BYTES, year: 2026 }).error, /no email/)
})

/* ── the notice that replaces silence ────────────────────────────────────── */

test('a paid invoice with no service writes to the desk, naming the invoice and the fix', () => {
  const { subject, text } = untaggedPaidNotice(plainPaid(), { origin: 'https://createspacebrand.com' })
  assert.match(subject, /CS-0051/)
  assert.match(subject, /Natalie Phoon/)
  assert.match(text, /\$1,800/)
  assert.match(text, /no service tagged/)
  assert.match(text, /https:\/\/createspacebrand\.com\/admin\//, 'the one place the fix lives')
  assert.match(text, /Open the engagement/, 'the button, by name')
  assert.match(text, /Brand direction, October/, 'the memo, so the reader knows what it was for')
  assert.match(text, /invoice\.stripe\.com/)
})

test('the other refused reasons are explained in their own words', () => {
  const tagged = plainPaid({ metadata: { kind: 'service', service: 'moon-landing', reference: 'CS-SVC-2026-K7M2PQ' } })
  assert.match(untaggedPaidNotice(tagged, { reason: 'unknown-service' }).text, /"moon-landing"/)
  assert.match(untaggedPaidNotice(plainPaid(), { reason: 'no-reference' }).text, /no reference/)
  assert.match(untaggedPaidNotice(plainPaid(), { reason: 'incomplete' }).text, /no name or no email/)
  // The reasons the webhook logs as errors are exactly these three; the
  // untagged case is a warning, because it is not necessarily a mistake.
  assert.deepEqual([...REFUSED_LOUDLY].sort(), ['incomplete', 'no-reference', 'unknown-service'])
})

test('a held commission tells the desk the real reason and where the retry is', () => {
  const { subject, text } = heldInvoiceNotice(plainPaid(), { reference: 'CS-SVC-2026-K7M2PQ', error: 'the signature did not match any configured secret' })
  assert.match(subject, /^HELD/)
  assert.match(text, /signature did not match/)
  assert.match(text, /CS-SVC-2026-K7M2PQ/)
  assert.match(text, /SERVICE_BRIDGE_SECRET/)
  assert.match(text, /Send to the desk again/)
})

test('a notice for an invoice Stripe sent half-empty still reads as a sentence', () => {
  const { subject, text } = untaggedPaidNotice({ id: 'in_x', amount_paid: 5000 })
  assert.match(subject, /in_x/)
  assert.match(subject, /an unnamed customer/)
  assert.match(text, /\$50/)
})

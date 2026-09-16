// The bridge, and the shelf behind it.
//
// The most important assertion in this file is the SIGNING VECTOR. The two
// sites are two repositories with no shared package between them, so each
// holds four lines of HMAC of its own. The vector below is byte-identical to
// the one in the workspace's shared/commissionCore.test.mjs — so if either
// side ever changes how it signs, both suites go red on the same commit, and
// nobody discovers it at 2am from a 401 in a webhook log.
import test from 'node:test'
import assert from 'node:assert/strict'
import { sign, SIGNATURE_HEADER, TIMESTAMP_HEADER, commissionFromOrder } from './commission.mjs'
import { SERVICES, SERVICE_IDS, BUYABLE, SCOPED, isBuyable, lookupKey, serviceForPrice, serviceLine, PAYMENT_MODES } from './services.mjs'
import { readScopeRequest } from '../functions/scope-request.mjs'

/* ── the wire ───────────────────────────────────────────────────────────── */

// Shared with the workspace. Change one, change both, or the bridge stops.
const VECTOR = {
  secret: 'createspace-bridge-test-secret',
  timestamp: '1700000000000',
  body: '{"reference":"CS-2026-TEST","serviceKey":"visual-brand-kit"}',
  signature: 'ff8711773f5a003846fc71f384e3b98cc47c257501540cf10805465ff36bb127',
}

test('the signing vector — the one thing both repositories must agree on', () => {
  const out = sign(VECTOR.body, VECTOR.secret, VECTOR.timestamp)
  assert.equal(out.timestamp, VECTOR.timestamp)
  assert.equal(
    out.signature,
    VECTOR.signature,
    'This signature changed. The workspace verifies against it — update shared/commissionCore.test.mjs in createspace-workspace in the same commit or the bridge stops.',
  )
})

test('the timestamp is signed material, not a header beside it', () => {
  const a = sign('{"x":1}', 'k', '1000')
  const b = sign('{"x":1}', 'k', '2000')
  assert.notEqual(a.signature, b.signature)
})

test('one edited byte produces a different signature', () => {
  assert.notEqual(sign('{"amount":89500}', 'k', '1').signature, sign('{"amount":95}', 'k', '1').signature)
})

test('the two sites agree on the header names', () => {
  assert.equal(SIGNATURE_HEADER, 'x-cs-commission-signature')
  assert.equal(TIMESTAMP_HEADER, 'x-cs-commission-timestamp')
})

/* ── the shelf ──────────────────────────────────────────────────────────── */

test('every service names the workspace catalog key it maps onto', () => {
  for (const id of SERVICE_IDS) {
    assert.equal(SERVICES[id].serviceKey, id, `${id} is keyed by its own catalog key`)
    assert.ok(SERVICES[id].name && SERVICES[id].turnaround && SERVICES[id].blurb, id)
    assert.ok(SERVICES[id].delivers.length >= 3, `${id} says what it delivers`)
    assert.ok(['03', '04'].includes(SERVICES[id].tier), id)
  }
})

test('the nine services the workspace sells are the nine this shelf offers', () => {
  // The workspace's own catalog (shared/serviceCatalogCore.mjs) is the master.
  // Its keys, copied here so a service added there and forgotten here is a
  // failing test rather than a page nobody can buy from.
  assert.deepEqual(
    [...SERVICE_IDS].sort(),
    [
      'brand-architecture', 'content-system-setup', 'creator-intensive', 'engagement-action-plan',
      'organizational-systems', 'profile-rebrand', 'social-strategy-sprint', 'storefront-buildout',
      'visual-brand-kit',
    ],
  )
})

test('tier 03 is buyable and tier 04 is scoped — the catalog’s rule, in code', () => {
  assert.equal(BUYABLE.length, 5)
  assert.equal(SCOPED.length, 4)
  for (const id of BUYABLE) assert.equal(SERVICES[id].tier, '03', id)
  for (const id of SCOPED) {
    assert.equal(SERVICES[id].tier, '04', id)
    assert.equal(isBuyable(id), false, `${id} has no checkout — no payment link until the scope is agreed`)
  }
})

test('the lookup keys are stable — they are typed into a Stripe dashboard by hand', () => {
  assert.equal(lookupKey('visual-brand-kit'), 'svc-visual-brand-kit')
  assert.equal(lookupKey('visual-brand-kit', 'deposit'), 'svc-visual-brand-kit-deposit')
  const keys = BUYABLE.flatMap((id) => PAYMENT_MODES.map((m) => lookupKey(id, m)))
  assert.equal(new Set(keys).size, keys.length, 'no two prices share a lookup key')
})

test('a Stripe price reads back to the service and the half of the fee it was', () => {
  assert.deepEqual(serviceForPrice({ lookup_key: 'svc-profile-rebrand' }), { id: 'profile-rebrand', mode: 'full' })
  assert.deepEqual(serviceForPrice({ lookup_key: 'svc-profile-rebrand-deposit' }), { id: 'profile-rebrand', mode: 'deposit' })
  assert.deepEqual(serviceForPrice({ id: 'price_x' }, { 'creator-intensive': { full: { priceId: 'price_x' } } }), { id: 'creator-intensive', mode: 'full' })
  assert.equal(serviceForPrice({ lookup_key: 'start-small' }), null, 'a product is not a service')
  assert.equal(serviceForPrice(null), null)
})

test('a deposit says so on the receipt', () => {
  assert.equal(serviceLine('visual-brand-kit'), 'Visual Brand Kit')
  assert.equal(serviceLine('visual-brand-kit', 'deposit'), 'Visual Brand Kit — deposit (50%)')
  assert.equal(serviceLine('nope'), '')
})

/* ── the commission ─────────────────────────────────────────────────────── */

const order = (over = {}) => ({
  reference: 'CS-SVC-2026-7KQ3MW',
  email: 'maya@example.com',
  name: 'Maya Chen',
  handle: 'mayacooks',
  platform: 'Instagram',
  niche: 'Weeknight cooking',
  notes: 'Launching a cookbook in November.',
  currency: 'usd',
  amount: 89500,
  joinCraft: false,
  ...over,
})

test('an order becomes a commission the workspace can open', () => {
  const c = commissionFromOrder({ order: order(), service: SERVICES['visual-brand-kit'], mode: 'full', intent: { id: 'pi_123' } })
  assert.equal(c.reference, 'CS-SVC-2026-7KQ3MW')
  assert.equal(c.kind, 'purchase')
  assert.equal(c.serviceKey, 'visual-brand-kit')
  assert.equal(c.tier, '03')
  assert.equal(c.amount, 89500)
  assert.equal(c.payment, 'full')
  assert.equal(c.client.email, 'maya@example.com')
  assert.equal(c.source, 'createspacebrand.com')
  assert.equal(c.origin, 'stripe:pi_123')
})

test('a deposit travels as a deposit — the workspace opens at the full fee', () => {
  const c = commissionFromOrder({ order: order({ amount: 44750 }), service: SERVICES['visual-brand-kit'], mode: 'deposit', intent: null })
  assert.equal(c.payment, 'deposit')
  assert.equal(c.amount, 44750)
})

test('what the buyer typed at the till travels as answers, so nothing is asked twice', () => {
  const c = commissionFromOrder({
    order: order(),
    service: SERVICES['visual-brand-kit'],
    answers: { 'Your niche, in your own words': 'Weeknight cooking' },
    notes: 'Launching a cookbook in November.',
  })
  assert.equal(c.answers['Your niche, in your own words'], 'Weeknight cooking')
  assert.match(c.notes, /cookbook/)
})

test('a commission carries no amount it invented and no price it was told', () => {
  const c = commissionFromOrder({ order: order({ amount: undefined }), service: SERVICES['creator-intensive'] })
  assert.equal(c.amount, 0, 'a missing amount is zero, never a guess from the catalog')
})

/* ── the scope door ─────────────────────────────────────────────────────── */

const scope = (over = {}) => ({
  service: 'social-strategy-sprint',
  name: 'Maya Chen',
  email: 'Maya@Example.com',
  handle: '@mayacooks',
  platform: 'Instagram',
  niche: 'Weeknight cooking',
  goal: 'I want to stop dreading posting and start charging what the work is worth.',
  ...over,
})

test('a complete scope request reads back normalised', () => {
  const { request, error } = readScopeRequest(scope())
  assert.equal(error, undefined)
  assert.equal(request.email, 'maya@example.com')
  assert.equal(request.handle, 'mayacooks', 'the @ is stored once, by the renderer')
})

test('a tier-03 build is sent to its checkout rather than down the scoping road', () => {
  const r = readScopeRequest(scope({ service: 'visual-brand-kit' }))
  assert.equal(r.buyable, true)
  assert.match(r.error, /already scoped and priced/)
})

test('the scope form asks for the four things a scope cannot be written without', () => {
  assert.match(readScopeRequest(scope({ service: '' })).error, /which service/)
  assert.match(readScopeRequest(scope({ name: '' })).error, /your name/)
  assert.match(readScopeRequest(scope({ email: 'nope' })).error, /email/)
  assert.match(readScopeRequest(scope({ goal: 'dunno' })).error, /what you want this to change/)
})

test('an unknown service is refused rather than opened as something else', () => {
  assert.match(readScopeRequest(scope({ service: 'a-thing-we-do-not-sell' })).error, /which service/)
})

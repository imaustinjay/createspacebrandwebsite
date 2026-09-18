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
import { sign, secretList, bridgeSecret, bridgeReady, SIGNATURE_HEADER, TIMESTAMP_HEADER, commissionFromOrder } from './commission.mjs'
import { SERVICES, SERVICE_IDS, BUYABLE, SCOPED, isBuyable, bookable, lookupKey, resolveServicePrices, serviceForPrice, serviceLine, PAYMENT_MODES } from './services.mjs'
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

test('with several secrets configured, we sign with the FIRST — never the whole string', () => {
  // The receiving side may try every value; a signature is made with exactly
  // one. Signing with the literal "new, old" would be refused by a workspace
  // that is correctly configured, which is the worst kind of failure: both
  // dashboards look right and every sale lands in the outbox.
  const before = process.env.SERVICE_BRIDGE_SECRET
  try {
    process.env.SERVICE_BRIDGE_SECRET = '  NEWKEY ,  OLDKEY  '
    assert.deepEqual(secretList(), ['NEWKEY', 'OLDKEY'])
    assert.equal(bridgeSecret(), 'NEWKEY')
    assert.equal(sign('{}', bridgeSecret(), '1').signature, sign('{}', 'NEWKEY', '1').signature)
    assert.notEqual(sign('{}', bridgeSecret(), '1').signature, sign('{}', 'NEWKEY ,  OLDKEY', '1').signature)

    process.env.SERVICE_BRIDGE_SECRET = ''
    assert.equal(bridgeSecret(), '')
    assert.equal(bridgeReady(), false, 'no secret means the bridge is not ready, and the outbox holds')
  } finally {
    if (before === undefined) delete process.env.SERVICE_BRIDGE_SECRET
    else process.env.SERVICE_BRIDGE_SECRET = before
  }
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

test('the catalog publishes a fee for five and scopes four — the catalog’s own shape', () => {
  assert.equal(BUYABLE.length, 5)
  assert.equal(SCOPED.length, 4)
  for (const id of BUYABLE) assert.equal(SERVICES[id].tier, '03', id)
  for (const id of SCOPED) assert.equal(SERVICES[id].tier, '04', id)
  // `isBuyable` is a fact about the CATALOG, not permission to charge. It used
  // to be the gate, which meant a scoped engagement could never be sold on the
  // site however settled its fee had become.
  for (const id of SCOPED) assert.equal(isBuyable(id), false, `${id} has no published fee in the catalog`)
})

test('the PRICE is the gate, not the tier — that is the catalog’s rule kept honestly', () => {
  // "No payment link is issued until the scope and the fee are agreed in
  // writing." Creating the Stripe price IS that agreement.
  assert.equal(bookable('social-strategy-sprint', {}), false, 'no price, no button — however much we would like to sell it')
  assert.equal(
    bookable('social-strategy-sprint', { 'social-strategy-sprint': { full: { amount: 59500 } } }),
    true,
    'a tier-04 engagement whose fee is settled and keyed sells, with no deploy',
  )
  assert.equal(
    bookable('visual-brand-kit', {}),
    false,
    'and a tier-03 build whose key is missing does NOT — better the scope door than a button that cannot charge',
  )
  // A deposit alone is never enough: half of a fee nobody set is not a number
  // this code may invent.
  assert.equal(bookable('brand-architecture', { 'brand-architecture': { deposit: { amount: 60000 } } }), false)
  assert.equal(bookable('brand-architecture', null), false)
  assert.equal(bookable('nothing-we-sell', { 'nothing-we-sell': { full: { amount: 1 } } }), true, 'the shelf decides what exists; this only reads prices')
})

test('the lookup keys are stable — they are typed into a Stripe dashboard by hand', () => {
  assert.equal(lookupKey('visual-brand-kit'), 'svc-visual-brand-kit')
  assert.equal(lookupKey('visual-brand-kit', 'deposit'), 'svc-visual-brand-kit-deposit')
  // ALL NINE, both modes. Every one of these eighteen is a string somebody
  // types into Stripe by hand, and two services sharing one would sell the
  // wrong engagement at the right price.
  const keys = SERVICE_IDS.flatMap((id) => PAYMENT_MODES.map((m) => lookupKey(id, m)))
  assert.equal(keys.length, 18)
  assert.equal(new Set(keys).size, keys.length, 'no two prices share a lookup key')
  for (const key of keys) {
    assert.match(key, /^svc-[a-z0-9-]+$/, `${key} is safe to type and safe to read back`)
  }
  // A deposit key is its full key plus a suffix, and nothing else. serviceForPrice
  // reads these back from a webhook, so the shape is load-bearing.
  for (const id of SERVICE_IDS) {
    assert.equal(lookupKey(id, 'deposit'), `${lookupKey(id)}-deposit`, id)
  }
})

test('every one of the nine reads back from its lookup key, scoped ones included', () => {
  // resolveServicePrices used to ask only for the tier-03 five. serviceForPrice
  // always read all nine — so a tier-04 price could be paid and recognised
  // while the shelf that offered it insisted it had none.
  for (const id of SERVICE_IDS) {
    assert.deepEqual(serviceForPrice({ lookup_key: lookupKey(id) }), { id, mode: 'full' }, id)
    assert.deepEqual(serviceForPrice({ lookup_key: lookupKey(id, 'deposit') }), { id, mode: 'deposit' }, id)
  }
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

test('a deposit travels as a deposit, and states the whole fee beside it', () => {
  const c = commissionFromOrder({ order: order({ amount: 44750, fullAmount: 89500 }), service: SERVICES['visual-brand-kit'], mode: 'deposit', intent: null })
  assert.equal(c.payment, 'deposit')
  assert.equal(c.amount, 44750)
  assert.equal(c.fullAmount, 89500, 'the workspace records the agreed fee rather than doubling the deposit')
})

test('a deposit that is not exactly half still names the right fee', () => {
  // $450 taken against an $895 build. Doubling would tell the workspace $900.
  const c = commissionFromOrder({ order: order({ amount: 45000, fullAmount: 89500 }), service: SERVICES['visual-brand-kit'], mode: 'deposit' })
  assert.equal(c.fullAmount, 89500)
})

test('an order with no stated fee carries zero, not a guess', () => {
  const c = commissionFromOrder({ order: order({ amount: 44750 }), service: SERVICES['visual-brand-kit'], mode: 'deposit' })
  assert.equal(c.fullAmount, 0)
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

test('a service with a price is sent to its checkout rather than down the scoping road', () => {
  const priced = { 'visual-brand-kit': { full: { amount: 89500 } } }
  const r = readScopeRequest(scope({ service: 'visual-brand-kit' }), priced)
  assert.equal(r.buyable, true)
  assert.match(r.error, /already priced/)
})

test('a service with NO price is scoped, whatever tier it is — including a tier-03 whose key is missing', () => {
  // The bug this replaces: the page lists anything unpriced in the scope
  // dropdown, so a tier-03 build with a missing lookup key was offered for
  // scoping and then refused on submit with "already scoped and priced" — the
  // one thing it was not.
  assert.equal(readScopeRequest(scope({ service: 'visual-brand-kit' }), {}).error, undefined)
  assert.equal(readScopeRequest(scope({ service: 'social-strategy-sprint' }), {}).error, undefined)
})

test('with no prices known at all, nobody is turned away', () => {
  // Stripe unreachable. A client asking to be scoped is never refused because
  // a payment API was down.
  for (const id of SERVICE_IDS) {
    assert.equal(readScopeRequest(scope({ service: id })).error, undefined, id)
  }
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

/* ── which prices the shelf actually asks Stripe for ────────────────────── */

/** A Stripe that holds exactly the lookup keys it is given. */
function fakeStripe(held = {}) {
  const asked = []
  return {
    asked,
    prices: {
      async list({ lookup_keys }) {
        asked.push(...lookup_keys)
        return {
          data: lookup_keys
            .filter((k) => k in held)
            .map((k) => ({ id: `price_${k}`, lookup_key: k, unit_amount: held[k], currency: 'usd' })),
        }
      },
      async retrieve(id) {
        return { id, unit_amount: held[id] ?? 1000, currency: 'usd' }
      },
    },
  }
}

test('the shelf asks Stripe for all nine, both modes — not only the tier-03 five', async () => {
  // It used to ask only for BUYABLE, which made the tier the gate: a scoped
  // engagement could not be sold however settled its fee had become, because
  // nothing ever looked for its price.
  const stripe = fakeStripe({})
  await resolveServicePrices(stripe)
  assert.equal(stripe.asked.length, 18, 'nine services, two modes each')
  for (const id of SERVICE_IDS) {
    assert.ok(stripe.asked.includes(lookupKey(id)), `${id} full`)
    assert.ok(stripe.asked.includes(lookupKey(id, 'deposit')), `${id} deposit`)
  }
  // Two calls of at most ten keys each — Stripe's ceiling — so asking for
  // nine services costs one call more than asking for five did, not the shelf.
  assert.ok(SCOPED.every((id) => stripe.asked.includes(lookupKey(id))))
})

test('a tier-04 engagement with a price in Stripe comes back priced and bookable', async () => {
  // The founder's ask, end to end: give Social Strategy Sprint's price the
  // lookup key svc-social-strategy-sprint and it sells, with no deploy.
  const stripe = fakeStripe({ 'svc-social-strategy-sprint': 59500, 'svc-social-strategy-sprint-deposit': 29750 })
  const prices = await resolveServicePrices(stripe)
  assert.equal(prices['social-strategy-sprint'].full.amount, 59500)
  assert.equal(prices['social-strategy-sprint'].deposit.amount, 29750)
  assert.equal(bookable('social-strategy-sprint', prices), true)
  // Its neighbours, un-keyed, stay scoped. One price does not open the shelf.
  assert.equal(bookable('brand-architecture', prices), false)
  assert.equal(bookable('engagement-action-plan', prices), false)
  assert.equal(bookable('visual-brand-kit', prices), false)
})

test('a full price alone is enough to sell; a deposit alone is not', async () => {
  const fullOnly = await resolveServicePrices(fakeStripe({ 'svc-organizational-systems': 89500 }))
  assert.equal(bookable('organizational-systems', fullOnly), true)
  assert.equal(fullOnly['organizational-systems'].deposit, undefined, 'the deposit button is simply not offered')

  const depositOnly = await resolveServicePrices(fakeStripe({ 'svc-organizational-systems-deposit': 44750 }))
  assert.equal(bookable('organizational-systems', depositOnly), false, 'half of a fee nobody set is not a number we may invent')
})

test('a price that resolves reads back to its own service, both ways', async () => {
  const prices = await resolveServicePrices(fakeStripe({ 'svc-brand-architecture': 120000 }))
  const byKey = serviceForPrice({ lookup_key: 'svc-brand-architecture' }, prices)
  const byId = serviceForPrice({ id: 'price_svc-brand-architecture' }, prices)
  assert.deepEqual(byKey, { id: 'brand-architecture', mode: 'full' })
  assert.deepEqual(byId, { id: 'brand-architecture', mode: 'full' })
})

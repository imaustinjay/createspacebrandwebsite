// SIGNAL's paywall, from the side that holds the money.
//
// The webhook is the ONLY thing that opens SIGNAL to a subscriber and the
// only thing that closes it again. So these tests are mostly about what must
// NOT come through it: the craft's own renewals, a price with no tier on it,
// and an event that arrived out of order and would reopen a subscription
// somebody cancelled.
//
// In tests/ rather than beside the function, for the reason the neighbouring
// suite already gives: netlify.toml points `functions` at netlify/functions,
// and Netlify publishes every top-level module in there as an endpoint.
import test from 'node:test'
import assert from 'node:assert/strict'
import { signalSubscription } from '../netlify/functions/stripe-webhook.mjs'
import { signalTier, entitlementRow, isFreshEvent, eventTime, TIERS } from '../netlify/shared/signal-entitlement.mjs'

const SECONDS = (iso) => Math.floor(new Date(iso).getTime() / 1000)
const PERIOD_END = '2026-07-15T12:00:00.000Z'

/** A SIGNAL subscription as Stripe sends it. */
const signalSub = (over = {}, priceMeta = { tier: 'pro', division: 'signal' }) => ({
  id: 'sub_signal1',
  object: 'subscription',
  status: 'active',
  customer: 'cus_1',
  cancel_at_period_end: false,
  current_period_end: SECONDS(PERIOD_END),
  metadata: {},
  items: { data: [{ price: { metadata: priceMeta } }] },
  ...over,
})

const evt = (sub, type = 'customer.subscription.updated', created = SECONDS('2026-06-15T12:00:00Z')) => ({
  id: 'evt_1', type, created, data: { object: sub },
})

/* ── what must pass through untouched ────────────────────────────────────── */

test('the craft’s own subscription is not SIGNAL and reaches none of this', () => {
  // The guard that matters most. Without it a $29 craft renewal mints a
  // SIGNAL workspace and hands over the product.
  const craft = signalSub({ id: 'sub_craft' }, { item: 'the-craft' })
  assert.equal(signalTier(craft), null)
  assert.equal(signalSubscription(evt(craft)).reason, 'not-signal')
})

test('a subscription with no price metadata at all passes through', () => {
  // Built by hand rather than through the helper: passing `undefined` for a
  // parameter with a default gets the default, which would have tested the
  // opposite of what this says.
  const shapes = [
    { data: [{ price: { metadata: {} } }] },
    { data: [{ price: {} }] },
    { data: [{}] },
    { data: [] },
    undefined,
  ]
  for (const items of shapes) {
    const sub = { id: 'sub_x', object: 'subscription', status: 'active', customer: 'cus_1', metadata: {}, items }
    assert.equal(signalSubscription(evt(sub)).reason, 'not-signal', JSON.stringify(items))
  }
})

test('a SIGNAL price found on a later item still counts', () => {
  // A cart that became one subscription puts more than one item on it. The
  // SIGNAL line is not guaranteed to be first.
  const sub = {
    id: 'sub_multi', object: 'subscription', status: 'active', customer: 'cus_1', metadata: {},
    current_period_end: SECONDS(PERIOD_END),
    items: { data: [
      { price: { metadata: { item: 'the-craft' } } },
      { price: { metadata: { tier: 'studio', division: 'signal' } } },
    ] },
  }
  assert.equal(signalSubscription(evt(sub)).tier, 'studio')
})

test('an object that is not a subscription passes through', () => {
  assert.equal(signalSubscription({ data: { object: {} } }).reason, 'not-a-subscription')
  assert.equal(signalSubscription({}).reason, 'not-a-subscription')
  assert.equal(signalSubscription().reason, 'not-a-subscription')
})

/* ── what SIGNAL claims ──────────────────────────────────────────────────── */

test('a SIGNAL subscription resolves its tier and a writable row', () => {
  const d = signalSubscription(evt(signalSub()))
  assert.equal(d.reason, undefined)
  assert.equal(d.tier, 'pro')
  assert.equal(d.row.source, 'stripe')
  assert.equal(d.row.status, 'active')
  assert.equal(d.row.stripe_sub_id, 'sub_signal1')
  assert.equal(d.row.stripe_customer_id, 'cus_1')
  assert.equal(d.row.current_period_end, PERIOD_END)
})

test('every tier the matrix sells is recognised', () => {
  for (const tier of TIERS) {
    assert.equal(signalSubscription(evt(signalSub({}, { tier, division: 'signal' }))).tier, tier)
  }
})

test('the bundle sells SIGNAL pro under a tier the matrix does not know', () => {
  // §13 files the craft + SIGNAL pro bundle as `tier: bundle` so the
  // Financials Dashboard categorises it correctly. `bundle` is not a tier
  // anyone can be entitled to, so without signal_tier a bundle subscriber
  // pays $59 and reaches nothing.
  const bundle = signalSub({}, { tier: 'bundle', signal_tier: 'pro', division: 'signal' })
  assert.equal(signalTier(bundle), 'pro')
  assert.equal(signalSubscription(evt(bundle)).tier, 'pro')
})

test('signal_tier is read ahead of tier, never averaged with it', () => {
  const both = signalSub({}, { tier: 'starter', signal_tier: 'studio', division: 'signal' })
  assert.equal(signalTier(both), 'studio')
})

test('a SIGNAL price with a tier we do not sell is refused, not guessed at', () => {
  const wrong = signalSub({}, { tier: 'enterprise', division: 'signal' })
  assert.equal(signalSubscription(evt(wrong)).reason, 'not-signal')
})

test('the buyer’s account id is carried from checkout metadata', () => {
  const d = signalSubscription(evt(signalSub({ metadata: { cs_user: 'user-abc' } })))
  assert.equal(d.userId, 'user-abc')
  assert.equal(signalSubscription(evt(signalSub())).userId, '', 'and is empty when they checked out signed-out')
})

/* ── closing the door ────────────────────────────────────────────────────── */

test('a deleted subscription is written as cancelled, not deleted', () => {
  // §15: failed payment and cancellation remove reach, never data. The row
  // stays and says `canceled`, which is what the resolver refuses on.
  const d = signalSubscription(evt(signalSub({ status: 'canceled' }), 'customer.subscription.deleted'))
  assert.equal(d.reason, undefined)
  assert.equal(d.row.status, 'canceled')
})

test('past_due and unpaid are carried through verbatim for the resolver to judge', () => {
  // This side records what Stripe said. What it MEANS is decided in the
  // workspace repo's entitlementCore, and translating it here would be a
  // second state machine drifting from the one holding the money.
  for (const status of ['past_due', 'unpaid', 'paused', 'incomplete']) {
    assert.equal(signalSubscription(evt(signalSub({ status }))).row.status, status)
  }
})

test('a cancellation pending at period end is recorded', () => {
  assert.equal(signalSubscription(evt(signalSub({ cancel_at_period_end: true }))).row.cancel_at_period_end, true)
})

/* ── the period end Stripe moved ─────────────────────────────────────────── */

test('the period end is found when Stripe keeps it on the item', () => {
  // catalog.mjs already carries the scar from the last time a field moved
  // unnoticed: `!invoice.subscription` was permanently true and every
  // membership renewal filed itself as an agency invoice.
  const moved = signalSub({
    current_period_end: undefined,
    items: { data: [{ current_period_end: SECONDS(PERIOD_END), price: { metadata: { tier: 'pro', division: 'signal' } } }] },
  })
  assert.equal(entitlementRow(moved, 'pro').current_period_end, PERIOD_END)
})

test('a period end in neither place is missing, never 1970', () => {
  const none = signalSub({ current_period_end: undefined, items: { data: [{ price: { metadata: { tier: 'pro' } } }] } })
  assert.equal(entitlementRow(none, 'pro').current_period_end, null,
    '0 would have become 1970 — a real date, and a date the resolver reads as merely expired')
})

test('an expanded customer object resolves to its id', () => {
  assert.equal(entitlementRow(signalSub({ customer: { id: 'cus_exp' } }), 'pro').stripe_customer_id, 'cus_exp')
})

test('garbage in is null out, not a half-built row', () => {
  for (const bad of [null, undefined, 'sub_1', 42]) assert.equal(entitlementRow(bad, 'pro'), null)
})

/* ── events that arrive out of order ─────────────────────────────────────── */

test('a retried update never reopens a cancelled subscription', () => {
  // Stripe does not promise order. The `deleted` raised at T+1 lands first;
  // the retried `updated` from T+0 arrives after and must change nothing.
  const held = { stripe_event_at: '2026-06-15T12:00:01.000Z' }
  assert.equal(isFreshEvent(held, '2026-06-15T12:00:00.000Z'), false)
  assert.equal(isFreshEvent(held, '2026-06-15T12:00:02.000Z'), true)
})

test('a replay of the same event rewrites the same values', () => {
  const held = { stripe_event_at: '2026-06-15T12:00:00.000Z' }
  assert.equal(isFreshEvent(held, '2026-06-15T12:00:00.000Z'), true,
    'idempotent by shape — §13 asks that a replay change nothing, not that it be refused')
})

test('a first event lands whatever its timestamp says', () => {
  assert.equal(isFreshEvent(null, '2020-01-01T00:00:00.000Z'), true)
  assert.equal(isFreshEvent({}, '2020-01-01T00:00:00.000Z'), true)
})

test('an event we cannot place in time may open an empty row and nothing else', () => {
  assert.equal(isFreshEvent(null, null), true)
  assert.equal(isFreshEvent({ stripe_event_at: '2026-06-15T12:00:00.000Z' }, null), false)
  assert.equal(isFreshEvent({ stripe_event_at: '2026-06-15T12:00:00.000Z' }, 'not a date'), false)
})

test('event times are read from Stripe’s whole seconds', () => {
  assert.equal(eventTime({ created: 1780000000 }), new Date(1780000000000).toISOString())
  for (const bad of [{}, null, { created: 'now' }, { created: NaN }]) assert.equal(eventTime(bad), null)
  assert.equal(signalSubscription(evt(signalSub())).eventAt, '2026-06-15T12:00:00.000Z')
})

/* ── the two mirrors stay in step ────────────────────────────────────────── */

test('the tier list matches the one the workspace resolves against', () => {
  // These are duplicated on purpose across two deploys — the same arrangement
  // creatorAccess.ts has with creatorAccessCore.mjs. If this ever fails, the
  // paywall and the thing writing to it disagree about what is sold.
  assert.deepEqual(TIERS, ['free', 'starter', 'pro', 'studio'])
})

test('the period comes from SIGNAL’s own line, not whichever line is first', () => {
  // Reachable here, not hypothetical: checkout.mjs puts every recurring item
  // into ONE subscription, so a cart holding the craft and a SIGNAL tier
  // makes a two-item subscription — and on the pinned API version the period
  // belongs to the item. Taking data[0] would bill SIGNAL to the craft's
  // clock the moment one of them was added mid-cycle.
  const craftEnd = SECONDS('2026-07-01T00:00:00.000Z')
  const signalEnd = SECONDS(PERIOD_END)
  const sub = {
    id: 'sub_two', object: 'subscription', status: 'active', customer: 'cus_1', metadata: {},
    current_period_end: undefined,
    items: { data: [
      { current_period_end: craftEnd, price: { metadata: { item: 'the-craft' } } },
      { current_period_end: signalEnd, price: { metadata: { tier: 'pro', division: 'signal' } } },
    ] },
  }
  assert.equal(signalSubscription(evt(sub)).row.current_period_end, PERIOD_END)
})

test('the first event of every signup is an incomplete subscription that grants nothing', () => {
  // Not an edge case here: checkout.mjs opens subscriptions with
  // `payment_behavior: 'default_incomplete'`, so `customer.subscription.created`
  // ALWAYS arrives before the card is confirmed. It is recorded, and the
  // resolver in the workspace repo refuses `incomplete` — which is what stops
  // an abandoned checkout from being a free account.
  const created = signalSubscription(
    evt(signalSub({ status: 'incomplete' }), 'customer.subscription.created'),
  )
  assert.equal(created.reason, undefined, 'it is still recorded')
  assert.equal(created.row.status, 'incomplete', 'and recorded as what it is')

  // Then the card clears and `updated` carries the status that does open it.
  const paid = signalSubscription(evt(signalSub({ status: 'active' })))
  assert.equal(paid.row.status, 'active')
})

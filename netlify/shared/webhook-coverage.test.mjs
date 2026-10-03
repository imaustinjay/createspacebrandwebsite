// The wiring panel's reading of Stripe's endpoints — written for the one
// event whose absence is silent. An endpoint created before the site handled
// `invoice.paid` does not send it; a paid agency invoice then opens nothing,
// and nobody is told. This is the check that makes that a row on a page.
import test from 'node:test'
import assert from 'node:assert/strict'
import { webhookCoverage, WANTED_EVENTS, WEBHOOK_PATH } from './webhook-coverage.mjs'

const ours = (over = {}) => ({
  id: 'we_1',
  url: 'https://createspacebrand.com/api/stripe-webhook',
  status: 'enabled',
  enabled_events: ['payment_intent.succeeded', 'payment_intent.payment_failed', 'setup_intent.succeeded', 'invoice.paid'],
  ...over,
})

test('the events the panel checks for are exactly the ones the webhook handles', () => {
  // HANDLED in stripe-webhook.mjs, by hand — the two must not drift.
  assert.deepEqual([...WANTED_EVENTS], ['payment_intent.succeeded', 'payment_intent.payment_failed', 'setup_intent.succeeded', 'invoice.paid'])
  assert.equal(WEBHOOK_PATH, '/api/stripe-webhook')
})

test('an endpoint that sends all four is read as complete', () => {
  const out = webhookCoverage([ours()])
  assert.equal(out.ours, 1)
  assert.deepEqual(out.missing, [])
  assert.equal(out.invoicePaid, true)
})

test('an endpoint created before invoice.paid was handled is named for what it is missing', () => {
  // The exact shape of the slip this exists for: three events ticked, the
  // fourth added to the site later and never ticked.
  const out = webhookCoverage([ours({ enabled_events: ['payment_intent.succeeded', 'payment_intent.payment_failed', 'setup_intent.succeeded'] })])
  assert.deepEqual(out.missing, ['invoice.paid'])
  assert.equal(out.invoicePaid, false)
})

test('a wildcard subscription sends everything', () => {
  const out = webhookCoverage([ours({ enabled_events: ['*'] })])
  assert.deepEqual(out.missing, [])
  assert.equal(out.invoicePaid, true)
})

test('a disabled endpoint and somebody else’s endpoint are not ours', () => {
  const out = webhookCoverage([
    ours({ status: 'disabled' }),
    { id: 'we_2', url: 'https://example.com/hooks/stripe', status: 'enabled', enabled_events: ['*'] },
  ])
  assert.equal(out.endpoints, 2)
  assert.equal(out.ours, 0)
  assert.equal(out.invoicePaid, null, 'nothing to say either way')
  assert.deepEqual(out.missing, [...WANTED_EVENTS])
})

test('two endpoints of ours cover between them', () => {
  // Test and live are separate endpoints; a preview deploy may have a third.
  // The question is whether the event is sent by any of them.
  const out = webhookCoverage([
    ours({ enabled_events: ['payment_intent.succeeded', 'payment_intent.payment_failed', 'setup_intent.succeeded'] }),
    ours({ id: 'we_3', enabled_events: ['invoice.paid'] }),
  ])
  assert.deepEqual(out.missing, [])
  assert.equal(out.invoicePaid, true)
})

test('given the deploy’s origin, only endpoints on that host count', () => {
  const list = [
    ours({ url: 'https://deploy-preview-12--createspace.netlify.app/api/stripe-webhook', enabled_events: ['invoice.paid'] }),
    ours({ id: 'we_4', enabled_events: ['payment_intent.succeeded'] }),
  ]
  assert.equal(webhookCoverage(list, { origin: 'https://createspacebrand.com' }).invoicePaid, false)
  assert.equal(webhookCoverage(list, { origin: 'https://deploy-preview-12--createspace.netlify.app' }).invoicePaid, true)
  // No origin: anywhere on the path counts, which is the panel's question.
  assert.equal(webhookCoverage(list).invoicePaid, true)
})

test('nothing, and garbage, are answered rather than thrown on', () => {
  assert.equal(webhookCoverage().ours, 0)
  assert.equal(webhookCoverage(null).invoicePaid, null)
  assert.equal(webhookCoverage([null, {}, { url: 7 }]).ours, 0)
})

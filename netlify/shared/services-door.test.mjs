// The shelf's door — /api/services — and the one thing it must never do:
// cache a read Stripe did not answer, and hand "no prices" to every phone
// that asks for the next five minutes while a laptop that asked a minute
// earlier still shows the fees.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolveServicePrices, bookable } from './services.mjs'
import { shelfPayload } from '../functions/services.mjs'

const good = () => ({
  prices: {
    async list({ lookup_keys }) {
      return { data: lookup_keys.filter((k) => k === 'svc-storefront-buildout').map((k) => ({ id: `price_${k}`, lookup_key: k, unit_amount: 59500, currency: 'usd' })) }
    },
    async retrieve(id) { return { id, unit_amount: 1000, currency: 'usd' } },
  },
})
const down = () => ({
  prices: {
    async list() { throw new Error('rate limited') },
    async retrieve() { throw new Error('rate limited') },
  },
})

test('a read Stripe did not answer is reported, not swallowed', async () => {
  const report = { errors: [] }
  const prices = await resolveServicePrices(down(), report)
  assert.deepEqual(prices, {})
  assert.equal(report.errors.length, 1)
  assert.match(report.errors[0], /rate limited/)
  // And the old callers, which pass no report, still get their shelf.
  const quiet = await resolveServicePrices(down())
  assert.deepEqual(quiet, {})
})

test('a failed read is sent with no-store and says pricesLive: false — never the catalog’s rule in disguise', async () => {
  const report = { errors: [] }
  const prices = await resolveServicePrices(down(), report)
  const { body, headers } = shelfPayload(prices, { configured: true, errors: report.errors })
  assert.equal(body.pricesLive, false)
  assert.equal(body.stripeConfigured, true)
  assert.equal(headers['cache-control'], 'no-store')
  assert.equal(body.services.find((s) => s.id === 'storefront-buildout').buyable, false)
})

test('a read that answered is cached and priced', async () => {
  const report = { errors: [] }
  const prices = await resolveServicePrices(good(), report)
  const { body, headers } = shelfPayload(prices, { configured: true, errors: report.errors, intakeLive: true })
  assert.equal(body.pricesLive, true)
  assert.equal(headers['cache-control'], 'public, max-age=60, s-maxage=300')
  const row = body.services.find((s) => s.id === 'storefront-buildout')
  assert.equal(row.buyable, true)
  assert.equal(row.price.display, '$595')
  assert.equal(bookable('visual-brand-kit', prices), false, 'no price in Stripe is a state, and it caches')
})

test('no Stripe key is a deliberate state: no prices, said so, cached', () => {
  const { body, headers } = shelfPayload({}, { configured: false })
  assert.equal(body.stripeConfigured, false)
  assert.equal(body.pricesLive, false)
  assert.equal(headers['cache-control'], 'public, max-age=60, s-maxage=300')
})

test('the page asks again past every cache before a fixed-price build reads as scoped', () => {
  const src = readFileSync(new URL('../../public/assets/services.js', import.meta.url), 'utf8')
  assert.match(src, /cache: attempt \? 'reload' : 'default'/, 'a retry bypasses the browser and edge caches')
  assert.match(src, /state\.settling = !state\.pricesLive && state\.stripeConfigured && attempt < SETTLE_TRIES/, 'settling only while Stripe is configured and the door said the read failed')
  assert.match(src, /Fetching the fee/, 'while settling, the fee is on its way')
  assert.match(src, /Fixed price · fee on request/, 'a tier-03 row without a price is never called "scoped in writing"')
  assert.match(src, /if \(state\.settling && s\.tier === '03'\) return/, 'a deep link to a fixed-price build waits for the answer rather than opening the scope door')
})

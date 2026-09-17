// The stockroom's shelf: a product added without a deploy.
//
// Seven products are written into SHELF by hand, each with a page built for
// it, its own photography and copy no form would have collected well. Adding
// an eighth used to mean editing four files and deploying — the server SHELF,
// a mirror of it in the browser's shop.js, a 295-line product page and a
// hand-written card on the index.
//
// These hold the rules that make the eighth safe: what a product must carry
// before it can be sold, what an id may be when it is about to become a URL
// and a Stripe lookup key at once, and the one collision that must never be
// allowed to merge.
import test from 'node:test'
import assert from 'node:assert/strict'
import { SHELF, IDS, slugFor, productLookupKey, readProductDraft } from './catalog.mjs'

const good = (over = {}) => ({
  name: 'The Caption Vault',
  delivery: 'PDF + Notion board',
  blurb: 'Three hundred captions, sorted by the job each one does.',
  ...over,
})

/* ── the id ─────────────────────────────────────────────────────────────── */

test('a name becomes an id that is safe as a URL, a Stripe key and a blob key at once', () => {
  assert.equal(slugFor('The Creator Planner 2026'), 'the-creator-planner-2026')
  assert.equal(slugFor('  Café Notes!  '), 'cafe-notes', 'accents folded, punctuation dropped, trimmed')
  assert.equal(slugFor('a & b'), 'a-b', 'never two hyphens in a row')
  assert.equal(slugFor('—'), '', 'nothing usable is empty, not a hyphen')
  assert.equal(slugFor(''), '')
  assert.equal(slugFor(null), '')
})

test('a long name is cut without leaving a trailing hyphen', () => {
  // A key ending in "-" is legal in a URL, ugly in Stripe, and the kind of
  // thing that gets retyped wrong once and never matches again.
  for (const n of ['x'.repeat(200), 'the ' + 'very '.repeat(40) + 'long one', 'a'.repeat(47) + ' b']) {
    const id = slugFor(n)
    assert.ok(id.length <= 48, `${id.length} <= 48`)
    assert.doesNotMatch(id, /-$/, id)
    assert.match(id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, id)
  }
})

test('the lookup key a product is shown IS the id the shop resolves', () => {
  // The whole point of it being a function: what the stockroom prints and what
  // resolvePrices looks for cannot drift, because they are one call.
  for (const id of IDS) assert.equal(productLookupKey(id), id)
  assert.equal(productLookupKey('  the-caption-vault  '), 'the-caption-vault')
  // Products use the bare id; only services carry the `svc-` prefix.
  assert.doesNotMatch(productLookupKey('the-caption-vault'), /^svc-/)
})

/* ── what a product must carry ──────────────────────────────────────────── */

test('a complete draft becomes a shelf entry in the shape SHELF uses', () => {
  const { product, error } = readProductDraft(good({ tier: 'Template pack', inside: ['300 captions', '  ', 'A Notion board'] }))
  assert.equal(error, undefined)
  assert.equal(product.id, 'the-caption-vault')
  assert.equal(product.name, 'The Caption Vault')
  assert.equal(product.tier, 'Template pack')
  assert.equal(product.href, '/shop/products/the-caption-vault/', 'always derived from the id')
  assert.deepEqual(product.inside, ['300 captions', 'A Notion board'], 'blank bullets dropped')
  assert.equal(product.custom, true, 'marked, so the page router knows to generate one')
  assert.equal(product.free, false)
  // Every key SHELF entries carry, so nothing downstream has to special-case it.
  for (const k of ['name', 'tier', 'delivery', 'href']) assert.ok(k in product, k)
})

test('the four things it refuses, and why each one matters', () => {
  assert.match(readProductDraft(good({ name: '' })).error, /name/i)
  assert.match(readProductDraft(good({ delivery: '' })).error, /what a buyer receives/i)
  assert.match(readProductDraft(good({ blurb: 'too short' })).error, /sentence or two/i)
  assert.match(readProductDraft(good({ name: '!!! ???' })).error, /no letters or numbers/i)
})

test('an id already on the shelf is refused, never merged', () => {
  // Reusing one inherits another product's files, its Stripe price and its
  // page — the worst kind of wrong, because everything keeps working while
  // the money goes to the wrong thing.
  const r = readProductDraft(good({ name: 'start small' }), SHELF)
  assert.match(r.error, /already a product at "start-small"/)
  assert.equal(r.product, undefined)
})

test('editing a product keeps its own id without colliding with itself', () => {
  const shelf = { 'the-caption-vault': { name: 'The Caption Vault', custom: true, createdAt: '2026-01-01T00:00:00.000Z' } }
  const r = readProductDraft({ ...good({ name: 'The Caption Vault, revised' }), id: 'the-caption-vault' }, shelf, { editing: 'the-caption-vault' })
  assert.equal(r.error, undefined)
  assert.equal(r.product.id, 'the-caption-vault', 'a rename never moves the id — files and price hang off it')
  assert.equal(r.product.name, 'The Caption Vault, revised')
})

test('a hand-typed id must be a slug already — it is about to be three things at once', () => {
  for (const id of ['Not_A_Slug', 'has spaces', 'UPPER', 'trailing-', '-leading', 'double--hyphen', 'sym$bol']) {
    assert.match(readProductDraft(good({ id })).error, /lowercase letters, numbers and single hyphens/, id)
  }
  assert.equal(readProductDraft(good({ id: 'a-good-id-2026' })).product.id, 'a-good-id-2026')
})

test('free is opt-in, and never inferred', () => {
  // A product that is free by accident is one nobody is ever charged for.
  assert.equal(readProductDraft(good()).product.free, false)
  assert.equal(readProductDraft(good({ free: 'yes' })).product.free, false, 'only a real true')
  assert.equal(readProductDraft(good({ free: true })).product.free, true)
})

test('long text is cut rather than refused, and the cuts are where a page can live with them', () => {
  const p = readProductDraft(good({
    name: 'n'.repeat(500),
    delivery: 'd'.repeat(500),
    blurb: 'b'.repeat(2000),
    inside: Array.from({ length: 40 }, (_, i) => `bullet ${i}`),
  })).product
  assert.equal(p.name.length, 80)
  assert.equal(p.delivery.length, 160)
  assert.equal(p.blurb.length, 600)
  assert.equal(p.inside.length, 12)
})

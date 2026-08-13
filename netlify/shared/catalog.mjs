// The shelf, and the Stripe connection that gives it prices.
//
// This module is the server's copy of the catalog and the only place that
// decides what anything costs — which is to say it decides nothing, because
// **Stripe is the source of truth for price.** The browser sends product ids;
// it never sends an amount, and an amount it did send would be ignored. That
// is the whole reason a cart in localStorage can be trusted at all.
//
// It lives outside netlify/functions on purpose: Netlify scans that directory
// for functions, and shared code that sits in it risks being deployed as an
// endpoint of its own. esbuild bundles this in wherever it's imported.
import Stripe from 'stripe'

// What the storefront sells, keyed by the id the cart stores. `name`, `tier`
// and `delivery` mirror the CATALOG in public/assets/shop.js — the two must
// agree, because one writes the emails and the other writes the page. The
// price is deliberately absent: see above.
export const SHELF = {
  'start-small': {
    name: 'start small',
    tier: 'Digital product',
    delivery: 'PDF guide + 30-day tracker',
    href: '/shop/products/start-small/',
  },
  'aesthetic-kit': {
    name: 'the Aesthetic Kit',
    tier: 'Digital product · Flagship',
    delivery: 'DNG + Lightroom presets, Canva template links, PDF guide',
    href: '/shop/products/aesthetic-kit/',
  },
  'creator-planner': {
    name: 'the Creator Planner 2026',
    tier: 'Digital product',
    delivery: 'Printable PDF + Notion + Google Sheets',
    href: '/shop/products/creator-planner/',
  },
  'content-system': {
    name: 'the Content System',
    tier: 'Digital product',
    delivery: 'Notion workspace + PDF + Sheets calendar',
    href: '/shop/products/content-system/',
  },
  'starter-bundle': {
    name: 'the Creator Starter Bundle',
    tier: 'The Bundle',
    delivery: 'All four products, delivered together',
    href: '/shop/products/starter-bundle/',
  },
  'the-craft': {
    name: 'the craft — membership',
    tier: 'Membership · Recurring',
    delivery: 'Access opens August 17',
    href: '/shop/the-craft/',
  },
}

export const IDS = Object.keys(SHELF)

// Env values arrive however they were pasted — strip wrapping quotes and edge
// whitespace, never interior content (same reasoning as enquiry.mjs).
export function clean(v) {
  if (typeof v !== 'string') return ''
  let s = v.trim()
  if (s.length > 1 && ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'")))) {
    s = s.slice(1, -1).trim()
  }
  return s
}

// Two ways to point a shelf id at a Stripe price, checked in this order:
//
//   1. STRIPE_PRICE_START_SMALL=price_123    — an env var per product.
//   2. the price's own lookup key in Stripe, set to the shelf id.
//
// The second needs no env vars at all: tag each price `start-small`,
// `aesthetic-kit`, … in the Stripe dashboard and the shelf resolves itself.
// The first exists because it's explicit, and because it wins — useful when a
// price is being swapped and the lookup key hasn't moved yet.
export function envPriceId(id) {
  return clean(process.env['STRIPE_PRICE_' + id.toUpperCase().replace(/-/g, '_')])
}

// `test` / `live` / null, from a key's own prefix.
export function keyMode(key) {
  const k = clean(key)
  if (k.startsWith('sk_live') || k.startsWith('pk_live')) return 'live'
  if (k.startsWith('sk_test') || k.startsWith('pk_test')) return 'test'
  return null
}

// Stripe's two worlds don't talk to each other: an intent opened with a live
// secret key cannot be confirmed by a test publishable key, or the reverse.
// Swapping four values by hand at go-live is exactly when one gets missed,
// and the failure surfaces late — at the moment a buyer presses Pay — with a
// message about the intent rather than about the keys.
//
// So the pair is checked before anything is opened. Returns null when they
// agree (or when one is missing, which is a different fault, reported
// elsewhere), and a sentence when they don't.
export function keyMismatch() {
  const secret = keyMode(process.env.STRIPE_SECRET_KEY)
  const publishable = keyMode(process.env.STRIPE_PUBLISHABLE_KEY)
  if (!secret || !publishable || secret === publishable) return null
  return `STRIPE_SECRET_KEY is a ${secret}-mode key and STRIPE_PUBLISHABLE_KEY is a ${publishable}-mode key — they must be the same mode`
}

let client = null

export function stripeClient() {
  const key = clean(process.env.STRIPE_SECRET_KEY)
  if (!key) return null
  if (!client) {
    const options = {
      // A payment page that hangs is worse than one that fails: fail fast,
      // retry the retryable, and let the caller say something honest.
      maxNetworkRetries: 2,
      timeout: 12000,
      appInfo: { name: 'createspacebrand.com storefront', url: 'https://createspacebrand.com' },
    }
    // Point the SDK at `stripe-mock` (or any stand-in) to exercise the whole
    // checkout locally without a Stripe account and without touching a real
    // one. Unset in every deployed environment, which is the only place it
    // would matter — set it and no request reaches Stripe at all.
    const host = clean(process.env.STRIPE_API_HOST)
    if (host) {
      options.host = host
      options.protocol = clean(process.env.STRIPE_API_PROTOCOL) || 'http'
      const port = Number(clean(process.env.STRIPE_API_PORT))
      if (port) options.port = port
      console.warn('stripe: talking to', options.protocol + '://' + host + (port ? ':' + port : ''))
    }
    client = new Stripe(key, options)
  }
  return client
}

// Currencies Stripe holds without a minor unit — ¥500 is 500, not 50000.
const ZERO_DECIMAL = new Set([
  'bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga',
  'pyg', 'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf',
])

// One money format for the whole system — the page, the summary, the emails.
// Whole amounts lose the ".00" because that's how the house writes a price.
export function money(amount, currency = 'usd') {
  if (typeof amount !== 'number' || !isFinite(amount)) return '—'
  const code = String(currency || 'usd').toLowerCase()
  const value = ZERO_DECIMAL.has(code) ? amount : amount / 100
  const whole = value % 1 === 0
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: code.toUpperCase(),
      minimumFractionDigits: whole ? 0 : 2,
      maximumFractionDigits: 2,
    }).format(value)
  } catch {
    return value.toFixed(whole ? 0 : 2) + ' ' + code.toUpperCase()
  }
}

function shape(id, price) {
  // Tiered and metered prices have no single amount to print. They're a
  // legitimate Stripe object, just not something this shelf can render, so
  // they're treated as unresolved rather than shown as a wrong number.
  if (typeof price.unit_amount !== 'number') return null
  const product = price.product && typeof price.product === 'object' ? price.product : null
  return {
    id,
    priceId: price.id,
    amount: price.unit_amount,
    currency: price.currency,
    display: money(price.unit_amount, price.currency),
    recurring: price.recurring
      ? { interval: price.recurring.interval, count: price.recurring.interval_count || 1 }
      : null,
    name: (product && product.name) || SHELF[id].name,
  }
}

// How a recurring price reads in a sentence: "$12 / month", "$99 / year".
export function recurringSuffix(recurring) {
  if (!recurring) return ''
  const { interval, count } = recurring
  return count > 1 ? ` / ${count} ${interval}s` : ` / ${interval}`
}

// Resolve every shelf id we can, and don't let one bad id take the rest with
// it: a typo'd env var costs that product its price, not the whole storefront.
// Returns a plain object keyed by shelf id; missing ids simply aren't there.
export async function resolvePrices(stripe) {
  const out = {}
  if (!stripe) return out

  const explicit = []
  const byLookup = []
  for (const id of IDS) {
    const priceId = envPriceId(id)
    if (priceId) explicit.push({ id, priceId })
    else byLookup.push(id)
  }

  const work = []

  if (byLookup.length) {
    work.push(
      stripe.prices
        .list({ lookup_keys: byLookup, active: true, limit: 100, expand: ['data.product'] })
        .then((list) => {
          for (const price of list.data) {
            const id = price.lookup_key
            if (!id || !SHELF[id] || out[id]) continue
            const row = shape(id, price)
            if (row) out[id] = row
          }
        })
        .catch((err) => {
          console.error('catalog: lookup-key read failed —', err?.message || err)
        })
    )
  }

  for (const { id, priceId } of explicit) {
    work.push(
      stripe.prices
        .retrieve(priceId, { expand: ['product'] })
        .then((price) => {
          const row = shape(id, price)
          if (row) out[id] = row
        })
        .catch((err) => {
          console.error(`catalog: ${id} → ${priceId} failed —`, err?.message || err)
        })
    )
  }

  await Promise.all(work)
  return out
}

// The reverse direction, for reading an order back: Stripe's price id (or its
// lookup key) → the shelf id, so a confirmation can name what was bought in
// the house's own words rather than the product's Stripe name.
export function shelfIdForPrice(price, prices = {}) {
  if (!price) return null
  if (price.lookup_key && SHELF[price.lookup_key]) return price.lookup_key
  for (const id of IDS) {
    if (prices[id] && prices[id].priceId === price.id) return id
    if (envPriceId(id) === price.id) return id
  }
  return null
}

// Where the site lives, for Stripe's return URLs.
//
// Never the request's Origin header: a forged one would mint a session on our
// account that returns the buyer to somebody else's page. The site's own env
// is the answer, and only a deploy preview is allowed to differ.
export function siteOrigin(req) {
  const context = clean(process.env.CONTEXT)
  if (context && context !== 'production') {
    const preview = clean(process.env.DEPLOY_PRIME_URL)
    if (preview) return preview.replace(/\/+$/, '')
  }
  const primary = clean(process.env.URL)
  if (primary) return primary.replace(/\/+$/, '')
  try {
    // `netlify dev`, where none of the above is set.
    const here = new URL(req.url)
    if (here.hostname === 'localhost' || here.hostname === '127.0.0.1') return here.origin
  } catch {
    /* fall through to the constant */
  }
  return 'https://createspacebrand.com'
}

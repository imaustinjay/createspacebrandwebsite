// The done-for-you shelf — the services the storefront sells, and the two ways
// of buying one.
//
// `SHELF` in catalog.mjs sells FILES: you pay, you get a download, the
// transaction is over in a second. This sells WORK: you pay, and a fortnight
// later a team hands you a brand. Same checkout, entirely different thing
// afterwards — which is why it is its own module and why every row here
// carries a `serviceKey`.
//
// **That key is the whole point.** It is the workspace's own catalog key
// (src/data/serviceCatalog.ts → shared/serviceCatalogCore.mjs, tiers 03 and
// 04). When a payment clears, the storefront sends a signed commission naming
// that key, and the workspace opens the engagement with the right manifest,
// the right team seats and the right assessment. The storefront does not know
// what a Visual Brand Kit consists of and must never need to — it knows what
// it costs and what to call it.
//
// **Two doors, because the catalog has two rules.**
//
//   Tier 03 — done-for-you builds. Fixed scope, a published "from" price, and
//   a checkout. You can buy one at 2am without talking to anybody.
//
//   Tier 04 — custom services. The catalog's own rule holds: *no payment link
//   is issued until the scope and the fee are agreed in writing.* So these
//   carry no price and no cart. Their door is **Request the scope of work**,
//   which is not a contact form — it opens a real engagement on the desk,
//   sends the client their assessment inside the minute, and the written scope
//   comes back built on their own answers.
//
// Prices, as everywhere on this site, come from Stripe and nowhere else. The
// browser sends a service key; an amount it sent would be ignored.
import { clean, money } from './catalog.mjs'

/** How a service may be paid for. */
export const PAYMENT_MODES = Object.freeze(['full', 'deposit'])

export const SERVICES = {
  'visual-brand-kit': {
    serviceKey: 'visual-brand-kit',
    name: 'Visual Brand Kit',
    tier: '03',
    turnaround: '2–3 weeks',
    blurb: 'A done-for-you visual identity system — palette, type, templates, the cohesive look.',
    delivers: [
      'A colour system with hex values and usage rules',
      'A type system: two faces, six defined roles',
      'Logo lockups in every orientation you need',
      'A one-page usage guide your editor can follow',
    ],
  },
  'storefront-buildout': {
    serviceKey: 'storefront-buildout',
    name: 'Storefront Buildout',
    tier: '03',
    turnaround: '1–2 weeks',
    blurb: 'Stan Store or link-in-bio built and styled, ready to sell from day one.',
    delivers: [
      'The storefront built, styled and live on your own platform',
      'Your offers written, priced and laid out to convert',
      'Checkout on rails you already trust',
      'A short handover so you can change it yourself',
    ],
  },
  'content-system-setup': {
    serviceKey: 'content-system-setup',
    name: 'Content System Setup',
    tier: '03',
    turnaround: '2 weeks',
    blurb: 'A content calendar and template system built for you, not handed to you.',
    delivers: [
      'A planning system built into the tools you actually open',
      'Templates for the formats you post most',
      'A weekly rhythm that fits the hours you really have',
      'The handover that makes it yours to run',
    ],
  },
  'creator-intensive': {
    serviceKey: 'creator-intensive',
    name: 'Creator Intensive',
    tier: '03',
    turnaround: '1 week',
    blurb: 'A done-with-you strategy session plus a written, personalised roadmap.',
    delivers: [
      'A diagnostic read of where you actually are',
      'One working session on the decision you keep circling',
      'A written roadmap with the order to do it in',
      'The follow-up, on a date, not a maybe',
    ],
  },
  'profile-rebrand': {
    serviceKey: 'profile-rebrand',
    name: 'Profile Rebrand',
    tier: '03',
    turnaround: '2–3 weeks',
    blurb: 'Full profile optimisation and visual rebrand across your platform.',
    delivers: [
      'Positioning and bio rewritten to say what you actually do',
      'The visual pass: grid, highlights, covers',
      'What survives the rebrand, kept deliberately',
      'A guide for keeping it consistent afterwards',
    ],
  },

  /* ── Tier 04 — scoped in writing first ─────────────────────────────────── */

  'social-strategy-sprint': {
    serviceKey: 'social-strategy-sprint',
    name: 'Social Strategy Sprint',
    tier: '04',
    turnaround: '2 weeks',
    blurb: 'A full 30-day content plan for your account, built on real research rather than a template.',
    delivers: [
      'An audit of what your audience has already said yes to',
      'Research on your platform and your niche, with its sources',
      'A 30-day plan, post by post: idea, hook, CTA, caption direction',
      'Shoot-ready scripts with a pacing breakdown, on the posts that need them',
    ],
  },
  'brand-architecture': {
    serviceKey: 'brand-architecture',
    name: 'Personal Brand Architecture',
    tier: '04',
    turnaround: '6–10 weeks',
    blurb: 'The five layers of a personal brand, built on what is actually true about you.',
    delivers: [
      'Positioning built on your own convictions, not a category',
      'The visual and verbal system that carries it',
      'Your offers, named and priced honestly',
      'The architecture written down, so it survives you being busy',
    ],
  },
  'organizational-systems': {
    serviceKey: 'organizational-systems',
    name: 'Organizational Systems',
    tier: '04',
    turnaround: '3–4 weeks',
    blurb: 'The working world behind the work — mapped, rebuilt and handed over.',
    delivers: [
      'An honest inventory of the tools actually in use',
      'The rebuild: one place for each kind of thing',
      'A delegation structure built for whoever comes next',
      'The handover, written for a person who was not in the room',
    ],
  },
  'engagement-action-plan': {
    serviceKey: 'engagement-action-plan',
    name: 'Engagement Action Plan',
    tier: '04',
    turnaround: '1 week',
    blurb: 'Thirty content ideas for your month, researched against your niche and the accounts you admire.',
    delivers: [
      'A live read of your platform and your niche, with sources',
      'Thirty ideas: hook, format, motion, CTA',
      'The approach behind them — times, cadence, structure',
      'Credited mechanics, never copied words',
    ],
  },
}

export const SERVICE_IDS = Object.keys(SERVICES)
// What the CATALOG publishes a price for. Tier 03 is sold at a published fee;
// tier 04 is scoped in writing first, because its fee is a range, a floor, or
// set on a call ($1,200–$2,200 for Personal Brand Architecture, "from $895"
// for Organizational Systems, "complimentary or paid" for the Engagement
// Action Plan).
//
// These are facts about the catalog, and they are no longer the gate. What
// decides whether a thing can be bought today is whether a PRICE FOR IT EXISTS
// IN STRIPE — see `bookable` below. That is the same rule the catalog states
// in its own terms: "No payment link is issued until the scope and the fee are
// agreed in writing." Creating the Stripe price IS that agreement, written
// down in the one place the money actually comes from. So a tier-04 engagement
// whose fee the house has settled on can be sold by giving its price a lookup
// key, with no deploy; and a tier-03 build whose price is missing or typo'd
// falls back to the scope door instead of offering a button that cannot charge.
export const BUYABLE = SERVICE_IDS.filter((id) => SERVICES[id].tier === '03')
export const SCOPED = SERVICE_IDS.filter((id) => SERVICES[id].tier === '04')
/** Does the CATALOG publish a fee for this? Not "can it be bought" — that is `bookable`. */
export const isBuyable = (id) => SERVICES[id]?.tier === '03'

/**
 * Can this be booked right now? True when a full-fee price resolved from
 * Stripe. The deposit is not required: half of a fee nobody has set is not a
 * number this code is allowed to invent, so a service with only a full price
 * sells at the full price and the deposit button simply is not offered.
 */
export const bookable = (id, prices = {}) => Boolean(prices?.[id]?.full)

/**
 * Two ways to point a service at a Stripe price, checked in this order —
 * identical to the product shelf's, because one convention is easier to
 * remember at 2am than two:
 *
 *   1. STRIPE_PRICE_SVC_VISUAL_BRAND_KIT=price_123
 *   2. the price's own lookup key in Stripe, set to `svc-visual-brand-kit`.
 *
 * The deposit — half the fee, the catalog's 50/50 split — is a SEPARATE Stripe
 * price rather than an amount this file halves. A price computed here would be
 * a price the browser could have sent, and the whole reason a cart in
 * localStorage is safe is that no amount is ever ours to decide.
 */
export const lookupKey = (id, mode = 'full') => (mode === 'deposit' ? `svc-${id}-deposit` : `svc-${id}`)
export const envPriceId = (id, mode = 'full') =>
  clean(process.env[`STRIPE_PRICE_SVC_${id.toUpperCase().replace(/-/g, '_')}${mode === 'deposit' ? '_DEPOSIT' : ''}`])

function shape(id, mode, price) {
  if (typeof price.unit_amount !== 'number') return null
  return {
    id,
    mode,
    priceId: price.id,
    amount: price.unit_amount,
    currency: price.currency,
    display: money(price.unit_amount, price.currency),
  }
}

/** Stripe: "You can specify up to 10 lookup_keys" on a price list. */
export const LOOKUP_KEYS_PER_CALL = 10

/**
 * Resolve every price we can, and never let one bad id take the rest with it:
 * a typo'd env var costs that service its button, not the whole page.
 *
 * Returns `{ 'visual-brand-kit': { full: {...}, deposit: {...} } }`, with
 * whichever modes actually resolved.
 *
 * EVERY service is asked for, tier-04 included. It used to ask only for the
 * tier-03 five, which made the tier the gate: a scoped engagement could not be
 * sold on the site however settled its fee had become, because nothing ever
 * looked for its price. Now the presence of the price is the gate, and the
 * absence of one costs nothing — the lookup-key read is `prices.list` in
 * batches of ten keys (Stripe's ceiling per call), and a key that matches
 * nothing is simply not in the answer.
 */
export async function resolveServicePrices(stripe, report = null) {
  const out = {}
  if (!stripe) return out
  // A read that fails is logged and SAID: `report.errors` lets the shelf's
  // door tell the difference between "Stripe holds no price for this" (a
  // configuration state, cacheable) and "Stripe did not answer" (a moment,
  // never to be cached or shown as if it were the catalog's rule).
  const failed = (msg) => { console.error(msg); if (report && Array.isArray(report.errors)) report.errors.push(String(msg)) }

  const wanted = []
  for (const id of SERVICE_IDS) for (const mode of PAYMENT_MODES) wanted.push({ id, mode })

  const explicit = []
  const byLookup = []
  for (const w of wanted) {
    const priceId = envPriceId(w.id, w.mode)
    if (priceId) explicit.push({ ...w, priceId })
    else byLookup.push(w)
  }

  const put = (id, mode, row) => {
    if (!row) return
    out[id] = out[id] || {}
    out[id][mode] = row
  }

  const work = []
  // Stripe's price list takes at most ten lookup keys per call. Nine services
  // in two modes is eighteen, so the read goes in batches of ten — asked for
  // in one call, Stripe refuses the whole thing and every service comes back
  // unpriced, which is the shelf saying "scoped in writing" for fees that are
  // sitting in Stripe. Each batch fails alone, like each explicit id does.
  for (let i = 0; i < byLookup.length; i += LOOKUP_KEYS_PER_CALL) {
    const batch = byLookup.slice(i, i + LOOKUP_KEYS_PER_CALL)
    const keys = batch.map((w) => lookupKey(w.id, w.mode))
    work.push(
      stripe.prices
        .list({ lookup_keys: keys, active: true, limit: 100 })
        .then((list) => {
          for (const price of list.data) {
            const hit = batch.find((w) => lookupKey(w.id, w.mode) === price.lookup_key)
            if (hit) put(hit.id, hit.mode, shape(hit.id, hit.mode, price))
          }
        })
        .catch((err) => failed(`services: lookup-key read failed (${keys[0]}…) — ${err?.message || err}`)),
    )
  }

  for (const { id, mode, priceId } of explicit) {
    work.push(
      stripe.prices
        .retrieve(priceId)
        .then((price) => put(id, mode, shape(id, mode, price)))
        .catch((err) => failed(`services: ${id} (${mode}) → ${priceId} failed — ${err?.message || err}`)),
    )
  }

  await Promise.all(work)
  return out
}

/** The reverse read, for a webhook: a Stripe price back to the service it
    bought, and which half of the fee it was. */
export function serviceForPrice(price, resolved = {}) {
  if (!price) return null
  // Both sides of every comparison are checked for existence first. A price
  // with no `id` against a shelf with no resolved price is `undefined ===
  // undefined`, which is true, and would cheerfully return the first service
  // in the list for somebody else's payment.
  for (const id of SERVICE_IDS) {
    for (const mode of PAYMENT_MODES) {
      if (price.lookup_key && price.lookup_key === lookupKey(id, mode)) return { id, mode }
      if (price.id && resolved[id]?.[mode]?.priceId === price.id) return { id, mode }
      if (price.id && envPriceId(id, mode) === price.id) return { id, mode }
    }
  }
  return null
}

/** What the page prints under each row, and what the receipt calls it. */
export const serviceLine = (id, mode = 'full') => {
  const s = SERVICES[id]
  if (!s) return ''
  return `${s.name}${mode === 'deposit' ? ' — deposit (50%)' : ''}`
}

/** Shares catalog.mjs's Stripe client, so a deploy holds one connection and
    one set of retry rules rather than two of each. */
// The house's reference for a service engagement, in the one format the
// workspace's desk recognises. Lived in service-checkout.mjs until the billing
// desk needed to mint one too; two copies of a reference format is how you end
// up with a CS-SVC that the workspace files under something else.
//
// No 0/O/1/I — a reference gets read aloud down a phone line.
const REF_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'
export function serviceReference(bytes, year) {
  let tail = ''
  for (const b of bytes) tail += REF_ALPHABET[b % REF_ALPHABET.length]
  return `CS-SVC-${year}-${tail}`
}

// The same format, read back. An agency job is often two invoices — a deposit
// and a balance — and each one paid fires its own `invoice.paid`. Reusing the
// first reference on the second is what makes the desk answer the second with
// the engagement it already opened instead of opening a duplicate, so the
// billing desk accepts one back and this decides whether it is really ours.
export const SERVICE_REFERENCE_RE = new RegExp(`^CS-SVC-[0-9]{4}-[${REF_ALPHABET}]{6}$`)
export const isServiceReference = (v) => SERVICE_REFERENCE_RE.test(String(v || '').trim().toUpperCase())

export { stripeClient } from './catalog.mjs'

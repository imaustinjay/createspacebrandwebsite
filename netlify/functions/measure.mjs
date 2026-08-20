// /api/measure — the only endpoint on this site that the public writes to
// without being asked to fill in a form.
//
// It takes one visit at a time and adds it to a counter. It is deliberately
// unable to do anything else: it stores no identifier, returns no body, sets
// no cookie, and reads nothing back out. Everything it keeps is written by
// netlify/shared/analytics.mjs, and the only door onto that is /api/insights,
// behind the portal's session.
//
//   POST /api/measure   { k: 'view' | 'dwell', ... }
//
// The response is always 204 with no body, whatever happened. A measurement
// endpoint that answers questions is a measurement endpoint being used for
// something else — and a visitor should never be shown an error for a beacon
// they did not know their browser sent.
import {
  channelOf,
  looksAutomated,
  readAgent,
  rateKey,
  recordDwell,
  recordView,
  tidyHost,
  today,
  visitorHash,
} from '../shared/analytics.mjs'

const DONE = { status: 204, headers: { 'Cache-Control': 'no-store' } }

// Only paths this site actually serves. Anything else is either a mistake or
// somebody testing what they can get into the counters, and neither belongs
// in a number the owner will make decisions on.
function tidyPath(raw) {
  let path = String(raw || '/').trim()
  if (!path.startsWith('/')) return null
  // No query, no fragment: a UTM tag is not a different page, and keeping
  // them would split one page's views across a dozen rows.
  path = path.split('?')[0].split('#')[0]
  if (path.length > 120) return null
  if (!/^[a-zA-Z0-9/_\-.]*$/.test(path)) return null
  // One trailing slash, always — /shop and /shop/ are the same page and must
  // not be two rows.
  if (path.length > 1 && !path.endsWith('/') && !path.includes('.')) path += '/'
  return path
}

function hostOf(raw) {
  try {
    // tidyHost also folds the platforms' link wrappers back onto the platform
    // — l.instagram.com is Instagram, and three rows for one source is three
    // rows nobody can read.
    return tidyHost(new URL(String(raw)).hostname)
  } catch {
    return ''
  }
}

// A per-IP ceiling, so one script cannot invent an afternoon of traffic. Two
// hundred an hour is far more than a person reads and far less than a flood.
const WINDOW_MS = 60 * 60 * 1000
const MAX_PER_WINDOW = 200
const memoryHits = new Map()

async function overLimit(ip) {
  const now = Date.now()
  // Never the address itself — see rateKey. The key rotates daily, so the
  // worst case is that somebody who was throttled just before midnight gets a
  // fresh allowance just after it, which is a fair trade for not writing down
  // who visited.
  const key = rateKey(ip, today())
  try {
    const { getStore } = await import('@netlify/blobs')
    const store = getStore('measure-rate')
    const hits = ((await store.get(key, { type: 'json' })) || []).filter((t) => now - t < WINDOW_MS)
    if (hits.length >= MAX_PER_WINDOW) return true
    hits.push(now)
    await store.setJSON(key, hits)
    return false
  } catch {
    const hits = (memoryHits.get(key) || []).filter((t) => now - t < WINDOW_MS)
    if (hits.length >= MAX_PER_WINDOW) return true
    hits.push(now)
    memoryHits.set(key, hits)
    return false
  }
}

export default async (req, context) => {
  if (req.method !== 'POST') return new Response(null, { status: 405 })

  const ua = req.headers.get('user-agent') || ''
  // Crawlers are traffic, but they are not readers, and mixing the two makes
  // every number on the dashboard mean less than it appears to.
  if (looksAutomated(ua)) return new Response(null, DONE)

  // A beacon from somewhere that is not this site is either a mistake or a
  // forgery. Either way it is not a visit here.
  const origin = req.headers.get('origin') || ''
  const site = req.headers.get('host') || ''
  if (origin && hostOf(origin) !== String(site).toLowerCase().replace(/^www\./, '').split(':')[0]) {
    return new Response(null, DONE)
  }

  let body = {}
  try {
    body = await req.json()
  } catch {
    return new Response(null, DONE)
  }

  const path = tidyPath(body.p)
  if (!path) return new Response(null, DONE)

  const ip =
    context?.ip ||
    req.headers.get('x-nf-client-connection-ip') ||
    (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() ||
    'unknown'
  if (await overLimit(ip)) return new Response(null, DONE)

  try {
    // ------------------------------------------------------- how long it held
    if (body.k === 'dwell') {
      await recordDwell({
        path,
        // Capped at half an hour: a tab left open overnight is not thirty
        // thousand seconds of reading, and one of those would swamp the mean.
        ms: Math.min(30 * 60 * 1000, Math.max(0, Number(body.ms) || 0)),
        scroll: Math.min(100, Math.max(0, Number(body.sc) || 0)),
        last: Boolean(body.last),
      })
      return new Response(null, DONE)
    }

    // ------------------------------------------------------------- a visit
    const agent = readAgent(ua)
    const referrerHost = hostOf(body.r)
    const ownHost = String(site).toLowerCase().replace(/^www\./, '').split(':')[0]

    await recordView({
      path,
      referrerHost: referrerHost && referrerHost !== ownHost ? referrerHost : '',
      channel: channelOf(referrerHost, ownHost),
      device: agent.device,
      browser: agent.browser,
      os: agent.os,
      // Netlify hands us the country it resolved at the edge. It never
      // reaches storage alongside anything else about the visit, so it is a
      // count of countries and not a location for a person.
      country: (context?.geo?.country?.code || '').toUpperCase() || '',
      firstOfSession: Boolean(body.n),
      // The second page of a visit. Named by the browser because the server
      // holds no session id — and counted by addition only, because the day
      // counters are sharded. See analytics.mjs.
      secondOfSession: Boolean(body.s2),
      visitor: visitorHash(ip, ua, today()),
    })
  } catch (err) {
    // A counter is never worth a 500 on a page somebody is reading.
    console.error('measure: could not record —', err?.message || err)
  }

  return new Response(null, DONE)
}

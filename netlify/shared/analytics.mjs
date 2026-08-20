// The site's own foot traffic — measured here, kept here, and readable by
// nobody but the owner.
//
// This exists instead of a third-party tag for three reasons. It needs no
// cookie banner, because it sets no cookie and stores no identifier a person
// could be followed by. It cannot be blocked into silence, because the beacon
// is same-origin and looks like every other request the site makes. And the
// numbers stay ours: no account, no sampling, and no retention policy written
// by somebody else.
//
// Shape on disk (Netlify Blobs, store `site-analytics`):
//
//   day/<YYYY-MM-DD>/<shard>   one day's counters, split eight ways
//   recent                     a short ring of the last few hundred views
//
// The sharding is the whole trick. Blobs has no atomic increment, so two
// visits landing in the same instant would each read the day, add one, and
// write it back — losing one of them. Eight shards make that collision eight
// times rarer, and a read simply sums the eight. Undercounting by a hair
// beats holding a lock on every pageview.
import { createHash, randomInt } from 'node:crypto'

const STORE = 'site-analytics'
const SHARDS = 8
const RECENT_MAX = 400

// Live means the last half hour, the same window every analytics product
// means by it.
export const LIVE_MS = 30 * 60 * 1000

// A day holds at most this many visitor fingerprints per shard before it
// stops adding new ones. 20k x 8 is far past anything this site will see, and
// the cap is what keeps one blob from growing without a ceiling.
const VISITOR_CAP = 20000

const memory = new Map()

async function open() {
  try {
    const { getStore } = await import('@netlify/blobs')
    return getStore({ name: STORE, consistency: 'strong' })
  } catch (err) {
    console.error('analytics: blobs unavailable, counting in memory —', err?.message || err)
    return null
  }
}

async function readJSON(key) {
  const store = await open()
  if (!store) return memory.get(key) ?? null
  try {
    return await store.get(key, { type: 'json' })
  } catch (err) {
    console.error(`analytics: read ${key} failed —`, err?.message || err)
    return null
  }
}

async function writeJSON(key, value) {
  const store = await open()
  if (!store) {
    memory.set(key, value)
    return true
  }
  try {
    await store.setJSON(key, value)
    return true
  } catch (err) {
    console.error(`analytics: write ${key} failed —`, err?.message || err)
    return false
  }
}

export function today(at = Date.now()) {
  return new Date(at).toISOString().slice(0, 10)
}

// The last `n` days, oldest first, as YYYY-MM-DD.
export function dayRange(n, endAt = Date.now()) {
  const days = []
  for (let i = n - 1; i >= 0; i--) days.push(today(endAt - i * 86400000))
  return days
}

// ------------------------------------------------------------- classifying
//
// Where a visit came from, in the five buckets that actually change what you
// would do about it. "AI assistants" is its own bucket rather than a corner
// of referral because it is the channel that did not exist when the other
// four were named, and it is the one worth watching now.

const SEARCH =
  /(^|\.)(google\.[a-z.]+|bing\.com|duckduckgo\.com|search\.yahoo\.[a-z.]+|yahoo\.[a-z.]+|ecosia\.org|search\.brave\.com|yandex\.[a-z.]+|baidu\.com|startpage\.com|qwant\.com|mojeek\.com)$/i
const ASSISTANT =
  /(^|\.)(chatgpt\.com|chat\.openai\.com|openai\.com|perplexity\.ai|claude\.ai|gemini\.google\.com|bard\.google\.com|copilot\.microsoft\.com|you\.com|phind\.com|poe\.com)$/i
const SOCIAL =
  /(^|\.)(instagram\.com|tiktok\.com|facebook\.com|twitter\.com|x\.com|t\.co|linkedin\.com|lnkd\.in|pinterest\.[a-z.]+|reddit\.com|youtube\.com|youtu\.be|threads\.net|threads\.com|tumblr\.com|discord\.com|snapchat\.com|substack\.com)$/i

// The link-wrapper hosts the big platforms send people through. They are the
// same source as the platform itself, and left alone they split one row into
// three and make the referrer list unreadable — `l.instagram.com` above
// `instagram.com` above `lm.instagram.com`, each with a couple of visits.
const SHIMS = {
  'l.instagram.com': 'instagram.com',
  'lm.instagram.com': 'instagram.com',
  'l.facebook.com': 'facebook.com',
  'lm.facebook.com': 'facebook.com',
  'm.facebook.com': 'facebook.com',
  'out.reddit.com': 'reddit.com',
  'away.vk.com': 'vk.com',
  't.co': 'x.com',
  'lnkd.in': 'linkedin.com',
  'youtu.be': 'youtube.com',
}

export function tidyHost(host) {
  const clean = String(host || '').toLowerCase().replace(/^www\./, '')
  return SHIMS[clean] || clean
}

export function channelOf(referrerHost, ownHost) {
  if (!referrerHost) return 'direct'
  if (ownHost && referrerHost === ownHost) return 'internal'
  if (ASSISTANT.test(referrerHost)) return 'ai'
  if (SEARCH.test(referrerHost)) return 'organic'
  if (SOCIAL.test(referrerHost)) return 'social'
  return 'referral'
}

// Enough of a user agent to tell a phone from a laptop and Safari from
// Chrome. Deliberately shallow: the exact version of anything is a
// fingerprinting surface and answers no question worth asking.
export function readAgent(ua = '') {
  const s = String(ua)
  const tablet = /iPad|Tablet|PlayBook|Silk|(Android(?!.*Mobile))/i.test(s)
  const mobile = !tablet && /Mobi|iPhone|iPod|Android|BlackBerry|IEMobile|Opera Mini/i.test(s)

  let browser = 'Other'
  if (/Edg\//i.test(s)) browser = 'Edge'
  else if (/OPR\/|Opera/i.test(s)) browser = 'Opera'
  else if (/SamsungBrowser/i.test(s)) browser = 'Samsung Internet'
  else if (/Firefox\//i.test(s)) browser = 'Firefox'
  else if (/Chrome\/|CriOS/i.test(s)) browser = 'Chrome'
  else if (/Safari\//i.test(s)) browser = 'Safari'

  let os = 'Other'
  if (/iPhone|iPad|iPod|iOS/i.test(s)) os = 'iOS'
  else if (/Mac OS X|Macintosh/i.test(s)) os = 'macOS'
  else if (/Android/i.test(s)) os = 'Android'
  else if (/Windows/i.test(s)) os = 'Windows'
  else if (/Linux|X11|CrOS/i.test(s)) os = 'Linux'

  return { device: tablet ? 'tablet' : mobile ? 'mobile' : 'desktop', browser, os }
}

// Anything that announces itself as a crawler, plus the headless runtimes
// that don't. Not exhaustive — nothing is — but it keeps uptime pings and
// preview fetchers out of a number the owner is going to make decisions on.
const BOT =
  /bot|crawler|spider|crawling|slurp|facebookexternalhit|embedly|quora link preview|whatsapp|telegram|discordbot|preview|scanner|monitor|uptime|pingdom|lighthouse|headless|phantomjs|puppeteer|playwright|python-requests|curl\/|wget|axios|go-http|java\/|okhttp|semrush|ahrefs|mj12|dotbot|petalbot|gptbot|ccbot|claudebot|anthropic-ai|perplexitybot|bytespider|amazonbot|applebot/i

export function looksAutomated(ua = '') {
  const s = String(ua).trim()
  // No user agent at all is not a browser. Every real one sends something.
  if (!s) return true
  return BOT.test(s)
}

// A visitor, counted without being identified.
//
// The IP and the user agent go in; eleven hex characters come out, salted
// with the date so the same person on the same phone is a different string
// tomorrow. There is no table anywhere that turns it back. It answers "how
// many people" and refuses to answer "which people", which is the only
// version of this number worth having.
export function visitorHash(ip, ua, date) {
  return createHash('sha256').update(`${date} ${ip} ${ua}`).digest('hex').slice(0, 11)
}

// The same idea for the beacon's rate limiter, which needs to recognise a
// caller across requests without knowing who they are.
//
// It matters more here than it looks. A rate limiter keyed by raw IP writes a
// durable record of every address that visited and when — under a key that is
// itself the address. Nothing reads that store back, but it would exist, it
// would never expire, and /privacy/ now tells people we do not keep their IP.
// A promise that depends on nobody looking at the storage is not a promise.
//
// Deliberately not salted with the user agent, unlike visitorHash: the point
// of the limiter is to hold one caller to a ceiling, and an agent string is
// the easiest thing in the world to vary between requests.
export function rateKey(ip, date) {
  return createHash('sha256').update(`rate ${date} ${ip}`).digest('hex').slice(0, 16)
}

// ------------------------------------------------------------ writing it

function blankDay(date) {
  return {
    date,
    views: 0,
    sessions: 0,
    engaged: 0,
    // Sessions that reached a second page. Bounces are `sessions - deepened`,
    // computed at read time rather than counted here — see recordView.
    deepened: 0,
    dwellMs: 0,
    dwellCount: 0,
    scrollSum: 0,
    scrollCount: 0,
    visitors: [],
    pages: {},
    landings: {},
    exits: {},
    referrers: {},
    channels: {},
    devices: {},
    browsers: {},
    systems: {},
    countries: {},
    hours: new Array(24).fill(0),
  }
}

function bump(map, key, by = 1) {
  if (!key) return
  map[key] = (map[key] || 0) + by
}

// One visit, folded into the day it happened on.
export async function recordView(event) {
  const date = today()
  const key = `day/${date}/${randomInt(0, SHARDS)}`
  const day = (await readJSON(key)) || blankDay(date)

  day.views += 1
  day.hours[new Date().getUTCHours()] += 1

  const page = day.pages[event.path] || { views: 0, entries: 0, exits: 0, dwellMs: 0, dwellCount: 0 }
  page.views += 1
  if (event.firstOfSession) page.entries += 1
  day.pages[event.path] = page

  // Channel is a property of the visit, not of every page in it. Counting it
  // per view meant three clicks through the site added three votes for
  // "within the site" and made the search visit that started them look like
  // a third of what it was. Counted on entry, the channels add up to visits,
  // which is what "where they came from" has to mean.
  if (event.firstOfSession) bump(day.channels, event.channel)
  bump(day.devices, event.device)
  bump(day.browsers, event.browser)
  bump(day.systems, event.os)
  bump(day.countries, event.country)
  if (event.referrerHost) bump(day.referrers, event.referrerHost)

  if (event.firstOfSession) {
    day.sessions += 1
    bump(day.landings, event.path)
  }
  // Only ever incremented, never decremented — which is what makes it survive
  // sharding. The obvious alternative (count every entry as a bounce, take it
  // back on the second view) reads and writes different shards for the two
  // halves, so the take-back lands on a counter that is already zero and the
  // bounce is never undone. That read as "everybody bounces" while the visits
  // were plainly three pages deep. The browser tells us which view is the
  // second one; the arithmetic happens at read time.
  if (event.secondOfSession) day.deepened += 1

  if (event.visitor && day.visitors.length < VISITOR_CAP && !day.visitors.includes(event.visitor)) {
    day.visitors.push(event.visitor)
  }

  await writeJSON(key, day)
  await pushRecent({
    at: Date.now(),
    path: event.path,
    channel: event.channel,
    device: event.device,
    country: event.country,
  })
  return true
}

// The other half of a visit: how long the page held them, and how far down
// they got. Arrives on pagehide, by sendBeacon, and may never arrive at all —
// which is why nothing above depends on it.
export async function recordDwell(event) {
  const date = today()
  const key = `day/${date}/${randomInt(0, SHARDS)}`
  const day = (await readJSON(key)) || blankDay(date)

  if (event.ms > 0) {
    day.dwellMs += event.ms
    day.dwellCount += 1
    const page = day.pages[event.path] || { views: 0, entries: 0, exits: 0, dwellMs: 0, dwellCount: 0 }
    page.dwellMs += event.ms
    page.dwellCount += 1
    day.pages[event.path] = page
  }
  if (typeof event.scroll === 'number' && event.scroll >= 0) {
    day.scrollSum += Math.min(100, event.scroll)
    day.scrollCount += 1
  }
  // Engaged: fifteen seconds or more on a page. The industry's definition,
  // and a fairer read of a small site than bounce rate on its own.
  if (event.ms >= 15000) day.engaged += 1
  if (event.last) {
    bump(day.exits, event.path)
    const page = day.pages[event.path] || { views: 0, entries: 0, exits: 0, dwellMs: 0, dwellCount: 0 }
    page.exits += 1
    day.pages[event.path] = page
  }

  await writeJSON(key, day)
  return true
}

async function pushRecent(entry) {
  const ring = (await readJSON('recent')) || []
  ring.push(entry)
  const cutoff = Date.now() - LIVE_MS
  await writeJSON('recent', ring.filter((e) => e.at > cutoff).slice(-RECENT_MAX))
}

// ------------------------------------------------------------- reading it

function mergeDay(into, part) {
  if (!part) return into
  into.views += part.views || 0
  into.sessions += part.sessions || 0
  into.engaged += part.engaged || 0
  into.deepened += part.deepened || 0
  into.dwellMs += part.dwellMs || 0
  into.dwellCount += part.dwellCount || 0
  into.scrollSum += part.scrollSum || 0
  into.scrollCount += part.scrollCount || 0
  for (const v of part.visitors || []) into.visitorSet.add(v)
  for (const [path, page] of Object.entries(part.pages || {})) {
    const held = into.pages[path] || { views: 0, entries: 0, exits: 0, dwellMs: 0, dwellCount: 0 }
    held.views += page.views || 0
    held.entries += page.entries || 0
    held.exits += page.exits || 0
    held.dwellMs += page.dwellMs || 0
    held.dwellCount += page.dwellCount || 0
    into.pages[path] = held
  }
  for (const field of ['landings', 'exits', 'referrers', 'channels', 'devices', 'browsers', 'systems', 'countries']) {
    for (const [k, n] of Object.entries(part[field] || {})) bump(into[field], k, n)
  }
  for (let h = 0; h < 24; h++) into.hours[h] += (part.hours || [])[h] || 0
  return into
}

// One day, whole — the eight shards summed back together.
//
// A day that has ended can never change again, so the sum is written back
// once as `rollup/<date>` and read as a single blob from then on. Without it
// a 180-day window is 1,440 reads every time somebody changes the range; with
// it, it is 180 after the first look. Today is always re-summed, because
// today is still being written to.
export async function readDay(date) {
  const closed = date < today()
  if (closed) {
    const held = await readJSON(`rollup/${date}`)
    if (held) return held
  }

  const day = blankDay(date)
  day.visitorSet = new Set()
  const parts = await Promise.all(Array.from({ length: SHARDS }, (_, i) => readJSON(`day/${date}/${i}`)))
  for (const part of parts) mergeDay(day, part)
  day.visitors = day.visitorSet.size
  delete day.visitorSet

  if (closed) await writeJSON(`rollup/${date}`, day)
  return day
}

// A span of days, both as one total and as a per-day series. The series is
// what a chart needs; the total is what a headline needs. Reading both from
// one pass keeps the blob reads down, which is the cost that matters here.
export async function readSpan(days) {
  const each = await Promise.all(days.map((d) => readDay(d)))
  const total = blankDay(`${days[0]} to ${days[days.length - 1]}`)
  total.visitorSet = new Set()
  const series = []

  for (const day of each) {
    mergeDay(total, { ...day, visitors: [] })
    series.push({ date: day.date, views: day.views, sessions: day.sessions, visitors: day.visitors })
  }
  delete total.visitorSet

  // Visitors per day, added up. The salt rotates daily, so the same person
  // genuinely is a different string on Tuesday and the union across days
  // cannot be recovered — by design. Every tool reports a range this way
  // unless it is keeping a durable identifier, and keeping one is the thing
  // this deliberately does not do.
  total.visitors = each.reduce((sum, d) => sum + d.visitors, 0)
  return { total, series }
}

export async function readRecent() {
  const ring = (await readJSON('recent')) || []
  const cutoff = Date.now() - LIVE_MS
  return ring.filter((e) => e.at > cutoff)
}

// Whether anything has ever been written. The difference between "no traffic"
// and "not measuring yet" is the single most important thing this page can
// get right.
export async function everMeasured(days = 14) {
  for (const date of dayRange(days)) {
    const parts = await Promise.all(Array.from({ length: SHARDS }, (_, i) => readJSON(`day/${date}/${i}`)))
    if (parts.some((p) => p && p.views > 0)) return true
  }
  return false
}

export const sortEntries = (map, limit = 10) =>
  Object.entries(map || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, count]) => ({ name, count }))

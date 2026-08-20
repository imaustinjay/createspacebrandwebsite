// Real search terms, from the only place they exist: Google Search Console.
//
// There is no honest way to invent this. Impressions, clicks and average
// position are measurements of Google's own index, and nothing computed on
// this side can stand in for them — so when the connection isn't configured
// this module says exactly that, and the portal prints "not connected"
// instead of a number. A dashboard that guesses at its search data is worse
// than one that admits it has none, because a guess gets acted on.
//
// The connection is a Google service account with read access to the
// property. No OAuth dance, no refresh token to babysit, no browser step: a
// signed assertion goes out, an access token comes back, and it is cached in
// the instance until it expires.
//
//   GOOGLE_SERVICE_ACCOUNT_JSON   the whole key file, pasted in, or
//   GSC_CLIENT_EMAIL + GSC_PRIVATE_KEY
//   GSC_SITE_URL                  sc-domain:createspacebrand.com
//
// Nothing here is written down anywhere. Every read is live, cached for a few
// minutes at most, and thrown away.
import { createSign } from 'node:crypto'
import { clean } from './catalog.mjs'

const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly'
const API = 'https://www.googleapis.com/webmasters/v3/sites'

// Search Console's own data is two to three days behind, always. Asking for
// yesterday returns an empty row set and reads as "we lost all our traffic",
// so every window this module opens ends three days ago and says so.
export const LAG_DAYS = 3

let cachedToken = null

function credentials() {
  const blob = clean(process.env.GOOGLE_SERVICE_ACCOUNT_JSON)
  if (blob) {
    try {
      const parsed = JSON.parse(blob)
      if (parsed.client_email && parsed.private_key) {
        return { email: parsed.client_email, key: parsed.private_key }
      }
      console.error('search console: GOOGLE_SERVICE_ACCOUNT_JSON has no client_email/private_key')
    } catch (err) {
      console.error('search console: GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON —', err?.message || err)
    }
  }
  const email = clean(process.env.GSC_CLIENT_EMAIL)
  // Netlify's env editor stores newlines as the two characters \ and n. A key
  // pasted straight in therefore has no real line breaks and the signer
  // rejects it — with an error that says nothing about why.
  const key = clean(process.env.GSC_PRIVATE_KEY).replace(/\\n/g, '\n')
  if (email && key) return { email, key }
  return null
}

export function property() {
  const set = clean(process.env.GSC_SITE_URL)
  if (set) return set
  // A domain property covers every subdomain and both protocols, which is
  // what this site has. It is also the form people forget, so guess it rather
  // than making the panel useless until somebody reads a README.
  const url = clean(process.env.URL)
  if (url) {
    try {
      return 'sc-domain:' + new URL(url).hostname.replace(/^www\./, '')
    } catch {
      /* fall through */
    }
  }
  return 'sc-domain:createspacebrand.com'
}

// { ok } · { ok: false, reason } — asked before anything is fetched, so the
// panel can explain itself without a round trip to Google.
export function connectionState() {
  const creds = credentials()
  if (!creds) return { ok: false, reason: 'no-credentials' }
  if (!/BEGIN (RSA )?PRIVATE KEY/.test(creds.key)) return { ok: false, reason: 'bad-key' }
  return { ok: true, serviceAccount: creds.email, property: property() }
}

function base64url(value) {
  return Buffer.from(value).toString('base64url')
}

async function accessToken() {
  if (cachedToken && cachedToken.expires > Date.now() + 30000) return cachedToken.value

  const creds = credentials()
  if (!creds) return null

  const now = Math.floor(Date.now() / 1000)
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claim = base64url(
    JSON.stringify({
      iss: creds.email,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600,
    })
  )

  let signature
  try {
    const signer = createSign('RSA-SHA256')
    signer.update(`${header}.${claim}`)
    signature = signer.sign(creds.key, 'base64url')
  } catch (err) {
    console.error('search console: could not sign the assertion — check GSC_PRIVATE_KEY —', err?.message || err)
    return null
  }

  let res
  try {
    res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${header}.${claim}.${signature}`,
      }),
    })
  } catch (err) {
    console.error('search console: token endpoint unreachable —', err?.message || err)
    return null
  }

  if (!res.ok) {
    console.error('search console: token refused —', res.status, (await res.text()).slice(0, 300))
    return null
  }

  const body = await res.json()
  cachedToken = { value: body.access_token, expires: Date.now() + (body.expires_in || 3600) * 1000 }
  return cachedToken.value
}

async function query(body) {
  const token = await accessToken()
  if (!token) return { ok: false, reason: 'no-token' }

  const url = `${API}/${encodeURIComponent(property())}/searchAnalytics/query`
  let res
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'web', dataState: 'final', ...body }),
    })
  } catch (err) {
    console.error('search console: query failed —', err?.message || err)
    return { ok: false, reason: 'unreachable' }
  }

  if (res.status === 403) {
    // The single most common setup mistake, and the one whose message from
    // Google explains the least: the key works, but nobody added it to the
    // property in the Search Console UI.
    console.error('search console: 403 — the service account is not a user on', property())
    return { ok: false, reason: 'not-shared' }
  }
  if (res.status === 404) {
    console.error('search console: 404 — no such property', property())
    return { ok: false, reason: 'no-property' }
  }
  if (!res.ok) {
    console.error('search console: query refused —', res.status, (await res.text()).slice(0, 300))
    return { ok: false, reason: 'refused' }
  }

  return { ok: true, rows: (await res.json()).rows || [] }
}

function isoDay(daysAgo) {
  return new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 10)
}

// Which shelf a term sits on, in the language somebody making decisions
// actually uses. The bands are Google's own page arithmetic: ten results to a
// page, so eleven is the top of page two and the most expensive place on the
// internet to be.
export function standing(position) {
  if (position <= 3) return 'winning'
  if (position <= 10) return 'working'
  if (position <= 20) return 'competing'
  if (position <= 50) return 'emerging'
  return 'distant'
}

// Roughly what share of searchers click a result at each position. Used only
// to spot a term that is ranking well and being ignored — a title problem,
// not a ranking problem, and the cheapest fix on any SEO list.
const EXPECTED_CTR = [0, 0.28, 0.15, 0.11, 0.08, 0.06, 0.05, 0.04, 0.03, 0.03, 0.02]

function expectedCtr(position) {
  const slot = Math.round(position)
  if (slot < 1) return EXPECTED_CTR[1]
  return EXPECTED_CTR[slot] ?? 0.01
}

// Everything the keyword panel shows, in one call: the totals, the terms, the
// pages earning them, and a day-by-day line. Four queries, run together.
export async function searchTerms({ days = 28 } = {}) {
  const state = connectionState()
  if (!state.ok) return { connected: false, reason: state.reason, property: property() }

  const endDate = isoDay(LAG_DAYS)
  const startDate = isoDay(LAG_DAYS + days)
  const priorEnd = isoDay(LAG_DAYS + days + 1)
  const priorStart = isoDay(LAG_DAYS + days * 2 + 1)
  const range = { startDate, endDate }

  const [totals, prior, terms, pages, daily] = await Promise.all([
    query({ ...range, rowLimit: 1 }),
    query({ startDate: priorStart, endDate: priorEnd, rowLimit: 1 }),
    query({ ...range, dimensions: ['query'], rowLimit: 500 }),
    query({ ...range, dimensions: ['page'], rowLimit: 100 }),
    query({ ...range, dimensions: ['date'], rowLimit: days + 2 }),
  ])

  if (!terms.ok) return { connected: false, reason: terms.reason, property: property() }

  const sum = (result) => {
    const row = (result.ok && result.rows[0]) || null
    return row
      ? { clicks: row.clicks || 0, impressions: row.impressions || 0, ctr: row.ctr || 0, position: row.position || 0 }
      : { clicks: 0, impressions: 0, ctr: 0, position: 0 }
  }

  const keywords = terms.rows
    .map((row) => {
      const position = row.position || 0
      const ctr = row.ctr || 0
      return {
        term: row.keys[0],
        clicks: row.clicks || 0,
        impressions: row.impressions || 0,
        ctr,
        position,
        standing: standing(position),
        // A term already on page one that nobody clicks is a headline
        // problem. A term on page two with real demand behind it is a
        // content problem. Both are worth naming; they are not the same job.
        underClicked: position <= 10 && (row.impressions || 0) >= 25 && ctr < expectedCtr(position) * 0.5,
        withinReach: position > 10 && position <= 20 && (row.impressions || 0) >= 20,
      }
    })
    .sort((a, b) => b.impressions - a.impressions)

  const byStanding = keywords.reduce((acc, k) => {
    acc[k.standing] = (acc[k.standing] || 0) + 1
    return acc
  }, {})

  return {
    connected: true,
    property: property(),
    serviceAccount: state.serviceAccount,
    window: { startDate, endDate, days, lagDays: LAG_DAYS },
    totals: sum(totals),
    prior: sum(prior),
    byStanding,
    keywords,
    pages: pages.ok
      ? pages.rows
          .map((row) => ({
            url: row.keys[0],
            clicks: row.clicks || 0,
            impressions: row.impressions || 0,
            ctr: row.ctr || 0,
            position: row.position || 0,
          }))
          .sort((a, b) => b.impressions - a.impressions)
      : [],
    series: daily.ok
      ? daily.rows
          .map((row) => ({
            date: row.keys[0],
            clicks: row.clicks || 0,
            impressions: row.impressions || 0,
            position: row.position || 0,
          }))
          .sort((a, b) => a.date.localeCompare(b.date))
      : [],
  }
}

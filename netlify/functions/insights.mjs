// /api/insights — everything the portal shows, behind the portal's session.
//
//   GET /api/insights?days=28[&refresh=1]
//
// One request, four sources: the site's own visit counters, Google Search
// Console, a live crawl of the site's own pages, and the playbook that reads
// all three and says what to do about them. They are assembled together
// because they are read together — a keyword panel means little without the
// page it lands on, and a finding means little without the traffic it costs.
//
// Every source can fail on its own without taking the page down. A panel that
// could not be filled says why it could not be filled; it never shows a zero
// that means "unknown", because a zero that means unknown is the one number
// on a dashboard that will actively mislead the person reading it.
import { siteOrigin } from '../shared/catalog.mjs'
import { clientIp, readSession } from '../shared/admin-session.mjs'
import { LIVE_MS, dayRange, everMeasured, readRecent, readSpan, sortEntries } from '../shared/analytics.mjs'
import { searchTerms } from '../shared/searchconsole.mjs'
import { auditSite } from '../shared/seo-audit.mjs'
import { buildPlaybook } from '../shared/seo-playbook.mjs'

const NO_STORE = { 'Cache-Control': 'no-store' }

// A percentage change that refuses to lie about a small base. Going from one
// visit to three is not "up 200%", it is up two visits, and a dashboard that
// prints the first sends somebody into a meeting with it.
function change(now, before) {
  if (!before) return { direction: now > 0 ? 'new' : 'flat', percent: null, from: before, to: now }
  const percent = ((now - before) / before) * 100
  return {
    direction: percent > 1 ? 'up' : percent < -1 ? 'down' : 'flat',
    // Under ten of anything, the ratio is noise wearing a percent sign.
    percent: before < 10 && now < 10 ? null : Math.round(percent),
    from: before,
    to: now,
  }
}

function shape(total, series, days) {
  const views = total.views
  const sessions = total.sessions
  return {
    views,
    visitors: total.visitors,
    sessions,
    // Mean time on a page, from the beacons that made it home. Not "time on
    // site": the last page of a visit rarely reports, and pretending
    // otherwise is how every analytics product overstates this.
    avgSeconds: total.dwellCount ? Math.round(total.dwellMs / total.dwellCount / 1000) : 0,
    dwellSamples: total.dwellCount,
    pagesPerSession: sessions ? Number((views / sessions).toFixed(2)) : 0,
    // Sessions that never reached a second page. Derived rather than
    // counted, so it cannot drift when a visit's views land on different
    // shards; clamped because a session begun yesterday can send its second
    // view today, which would otherwise read as a negative bounce.
    bounceRate: sessions ? Math.min(100, Math.max(0, Math.round(((sessions - total.deepened) / sessions) * 100))) : 0,
    engagedRate: views ? Math.round((total.engaged / views) * 100) : 0,
    avgScroll: total.scrollCount ? Math.round(total.scrollSum / total.scrollCount) : 0,
    days,
    series,
  }
}

async function trafficView(days) {
  const window = dayRange(days)
  const priorWindow = dayRange(days, Date.now() - days * 86400000)

  const [current, prior, recent] = await Promise.all([readSpan(window), readSpan(priorWindow), readRecent()])
  const { total, series } = current

  // Anything in the window settles it. Only an empty window needs the extra
  // look back, and only to tell "nobody came" apart from "nothing is
  // counting" — which are different problems and must not read the same.
  const measuring = total.views > 0 || prior.total.views > 0 || (await everMeasured(14))
  const totals = shape(total, series, days)

  const pages = Object.entries(total.pages)
    .map(([path, page]) => ({
      path,
      views: page.views,
      entries: page.entries,
      exits: page.exits,
      avgSeconds: page.dwellCount ? Math.round(page.dwellMs / page.dwellCount / 1000) : 0,
    }))
    .sort((a, b) => b.views - a.views)
    .slice(0, 20)

  return {
    measuring,
    window: { days, from: window[0], to: window[window.length - 1] },
    totals,
    change: {
      views: change(total.views, prior.total.views),
      visitors: change(total.visitors, prior.total.visitors),
      sessions: change(total.sessions, prior.total.sessions),
      bounceRate: change(
        totals.bounceRate,
        prior.total.sessions
          ? Math.min(100, Math.max(0, Math.round(((prior.total.sessions - prior.total.deepened) / prior.total.sessions) * 100)))
          : 0
      ),
    },
    pages,
    landings: sortEntries(total.landings, 10),
    exits: sortEntries(total.exits, 10),
    referrers: sortEntries(total.referrers, 12),
    channels: sortEntries(total.channels, 8),
    devices: sortEntries(total.devices, 4),
    browsers: sortEntries(total.browsers, 6),
    systems: sortEntries(total.systems, 6),
    countries: sortEntries(total.countries, 10),
    hours: total.hours,
    avgScroll: totals.avgScroll,
    live: {
      minutes: Math.round(LIVE_MS / 60000),
      views: recent.length,
      pages: sortEntries(
        recent.reduce((acc, e) => {
          acc[e.path] = (acc[e.path] || 0) + 1
          return acc
        }, {}),
        6
      ),
    },
  }
}

export default async (req, context) => {
  if (req.method !== 'GET') return new Response('Method Not Allowed', { status: 405 })

  const session = readSession(req)
  if (!session) {
    return Response.json(
      { error: 'Not authorised.', reason: 'signed-out' },
      { status: 401, headers: { ...NO_STORE, 'WWW-Authenticate': 'Session' } }
    )
  }

  const params = new URL(req.url).searchParams
  // Bounded: a 365-day read is 365 x 8 blob reads, which is a slow page and a
  // bill. Four windows cover every question this page is asked.
  const asked = Number(params.get('days')) || 28
  const days = [7, 28, 90, 180].includes(asked) ? asked : 28
  const refresh = params.get('refresh') === '1'
  const origin = siteOrigin(req)

  // In parallel, and each caught on its own. Search Console being down is not
  // a reason to withhold the traffic numbers.
  const [traffic, search, audit] = await Promise.all([
    trafficView(days).catch((err) => {
      console.error('insights: traffic read failed —', err?.message || err)
      return { measuring: false, error: 'The visit counters could not be read just now.' }
    }),
    searchTerms({ days: Math.min(days, 90) }).catch((err) => {
      console.error('insights: search console read failed —', err?.message || err)
      return { connected: false, reason: 'unreachable' }
    }),
    auditSite(origin, { force: refresh }).catch((err) => {
      console.error('insights: crawl failed —', err?.message || err)
      return { error: 'The crawl could not be run just now.', pages: [] }
    }),
  ])

  console.log('insights: served', { ip: clientIp(req, context), days, refresh })

  return Response.json(
    {
      ok: true,
      generatedAt: Date.now(),
      sessionExpiresAt: session.exp,
      origin,
      traffic,
      search,
      audit,
      playbook: buildPlaybook({ audit, search, traffic }),
    },
    { headers: NO_STORE }
  )
}

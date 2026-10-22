import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { POSTINGS, FORMS, fieldIds, requiredIds, postingFor, postingState, pacificDay, dayInWords, readCareers } from '../../public/assets/careers-core.mjs'
import { applicationFrom, careersReference } from './careers.mjs'

/* ── the vector both repositories hold ───────────────────────────────────
   The workspace's shared/careersCore.test.mjs asserts the same lists against
   its ROLE_KEYS and its own form (src/data/applications.ts). A field renamed
   on either side turns both suites red on the same commit. */
const SHARED = ['full_name', 'email', 'phone', 'location', 'pronouns', 'links', 'availability', 'referral']
const VECTOR = {
  'brand-architect-intern': [...SHARED, 'bai_path', 'bai_portfolio_piece', 'bai_brand_admire', 'bai_strengths', 'bai_tools', 'bai_hours', 'bai_timezone', 'bai_live_sessions', 'bai_why', 'bai_feedback', 'bai_brief'],
  'brand-architect-jr': [...SHARED, 'baj_years', 'baj_case', 'baj_systems', 'baj_strengths', 'baj_tools', 'baj_critique', 'baj_hours', 'baj_timezone', 'baj_cohort', 'baj_why'],
  'content-creator': [...SHARED, 'ccc_handle', 'ccc_portfolio', 'ccc_styles', 'ccc_gear', 'ccc_gear_detail', 'ccc_direction', 'ccc_cadence', 'ccc_turnaround', 'ccc_why'],
  'social-strategist': [...SHARED, 'str_approach', 'str_sources', 'str_warm_brand', 'str_years', 'str_cadence', 'str_brief', 'str_analytics_comfort', 'str_tools', 'str_why', 'str_pod'],
}
const REQUIRED = {
  'brand-architect-intern': ['full_name', 'email', 'location', 'availability', 'bai_path', 'bai_portfolio_piece', 'bai_brand_admire', 'bai_hours', 'bai_timezone', 'bai_live_sessions', 'bai_why', 'bai_feedback', 'bai_brief'],
  'brand-architect-jr': ['full_name', 'email', 'location', 'availability', 'baj_years', 'baj_case', 'baj_systems', 'baj_critique', 'baj_hours', 'baj_timezone', 'baj_why'],
  'content-creator': ['full_name', 'email', 'location', 'availability', 'ccc_handle', 'ccc_portfolio', 'ccc_styles', 'ccc_direction', 'ccc_cadence', 'ccc_why'],
  'social-strategist': ['full_name', 'email', 'location', 'availability', 'str_approach', 'str_warm_brand', 'str_years', 'str_cadence', 'str_brief', 'str_analytics_comfort', 'str_why'],
}

test('the forms carry exactly the workspace’s field ids, in its order', () => {
  for (const [slug, ids] of Object.entries(VECTOR)) {
    assert.deepEqual(fieldIds(slug), ids, slug)
    assert.deepEqual(new Set(requiredIds(slug)), new Set(REQUIRED[slug]), slug)
  }
  assert.deepEqual(Object.keys(FORMS).sort(), Object.keys(VECTOR).sort())
})

test('the postings name the workspace’s seats exactly (the naming the space uses)', () => {
  assert.deepEqual(POSTINGS.map((p) => p.role), ['Brand Architect Intern', 'Brand Architect Jr.', 'Content Creator (Contract)', 'Social Strategist'])
  assert.deepEqual(POSTINGS.map((p) => p.req), ['CS-REQ-BRA-I01', 'CS-REQ-BRA-J01', 'CS-REQ-CC-C01', 'CS-REQ-STR-01'])
  for (const p of POSTINGS) assert.equal(p.location, 'Remote')
})

/* ── the window ──────────────────────────────────────────────────────── */

test('the intern cohort is open from Oct 13 to Nov 30 (Pacific); the Jr. seat opens Nov 2', () => {
  const intern = postingFor('brand-architect-intern')
  const jr = postingFor('brand-architect-jr')
  assert.equal(postingState(intern, new Date('2026-10-13T19:00:00Z')), 'open')
  assert.equal(postingState(intern, new Date('2026-12-01T07:00:00Z')), 'open', '11pm Nov 30 Pacific')
  assert.equal(postingState(intern, new Date('2026-12-01T09:00:00Z')), 'closed')
  assert.equal(postingState(jr, new Date('2026-10-20T19:00:00Z')), 'upcoming')
  assert.equal(postingState(jr, new Date('2026-11-02T08:30:00Z')), 'open', '00:30 Nov 2 Pacific')
  assert.equal(postingState({ ...jr, status: 'paused' }, new Date('2026-11-10T19:00:00Z')), 'paused')
  assert.equal(pacificDay(new Date('2026-11-02T06:00:00Z')), '2026-11-01')
  assert.equal(dayInWords('2026-11-02'), 'Monday, November 2')
})

/* ── reading a submission ────────────────────────────────────────────── */

export const GOOD = {
  full_name: 'Ava Lin', email: 'Ava@Example.com', location: 'Oakland, CA', availability: 'Within 2 weeks',
  bai_path: 'Recently graduated', bai_portfolio_piece: 'https://ava.work — the thinking', bai_brand_admire: 'Aesop',
  bai_strengths: ['Typography', 'Not a real option'], bai_hours: '15–20', bai_timezone: 'Pacific', bai_live_sessions: 'Yes',
  bai_why: 'Because.', bai_feedback: 'A crit on kerning.', bai_brief: 'Start with the regulars.',
}

test('an application keeps only real fields and real options', () => {
  const { submission } = readCareers({ posting: 'brand-architect-intern', answers: { ...GOOD, is_admin: true } })
  assert.equal(submission.kind, 'application')
  assert.equal(submission.email, 'ava@example.com')
  assert.deepEqual(submission.answers.bai_strengths, ['Typography'])
  assert.equal(submission.answers.is_admin, undefined)
  for (const k of Object.keys(submission.answers)) assert.ok(VECTOR['brand-architect-intern'].includes(k), k)
})

test('a missing answer names itself; a select outside its list is refused', () => {
  const { bai_brief: _b, ...short } = GOOD
  const a = readCareers({ posting: 'brand-architect-intern', answers: short })
  assert.equal(a.field, 'bai_brief')
  const b = readCareers({ posting: 'brand-architect-intern', answers: { ...GOOD, bai_hours: '60' } })
  assert.equal(b.field, 'bai_hours')
  assert.match(readCareers({ posting: 'nope', answers: GOOD }).error, /posting/)
  assert.equal(readCareers({ posting: 'brand-architect-intern', answers: { ...GOOD, email: 'x@y' } }).field, 'email')
})

test('interest is a name and an email (and a note, if they leave one)', () => {
  const { submission } = readCareers({ posting: 'brand-architect-jr', kind: 'interest', answers: { full_name: 'Sam', email: 'sam@example.com', note: 'Following.' } })
  assert.deepEqual(submission.answers, { full_name: 'Sam', email: 'sam@example.com', note: 'Following.' })
})

test('the wire carries the reference the workspace dedupes on', () => {
  const ref = careersReference()
  assert.match(ref, /^CS-APP-/)
  const { submission } = readCareers({ posting: 'brand-architect-intern', answers: GOOD })
  const wire = applicationFrom(submission, ref)
  assert.deepEqual(Object.keys(wire), ['reference', 'posting', 'kind', 'name', 'email', 'answers'])
  assert.equal(wire.posting, 'brand-architect-intern')
})

/* ── the door ────────────────────────────────────────────────────────── */

import handler from '../functions/careers.mjs'

const post = (body, ip) =>
  handler(new Request('https://createspacebrand.com/api/careers', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), { ip })

const stubFetch = (status, json = {}) => {
  const calls = []
  const prev = globalThis.fetch
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); return new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } }) }
  return { calls, restore: () => { globalThis.fetch = prev } }
}
const withSecret = async (fn) => {
  const env = process.env.SERVICE_BRIDGE_SECRET
  process.env.SERVICE_BRIDGE_SECRET = 'test-secret'
  try { return await fn() } finally { if (env === undefined) delete process.env.SERVICE_BRIDGE_SECRET; else process.env.SERVICE_BRIDGE_SECRET = env }
}

test('a honeypot or a three-second fill is thanked and thrown away', async () => {
  const f = stubFetch(200)
  try {
    assert.equal((await (await post({ posting: 'brand-architect-intern', answers: GOOD, website: 'x', elapsedMs: 90000 }, '198.51.100.1')).json()).ok, true)
    assert.equal((await (await post({ posting: 'brand-architect-intern', answers: GOOD, elapsedMs: 800 }, '198.51.100.1')).json()).ok, true)
    assert.equal(f.calls.length, 0, 'nothing crossed the bridge')
  } finally { f.restore() }
})

test('an application crosses the signed bridge to the workspace and is filed there', async () => {
  await withSecret(async () => {
    const f = stubFetch(200, { received: true, filed: 'application', id: 'u1' })
    try {
      const res = await post({ posting: 'brand-architect-intern', kind: 'application', answers: GOOD, elapsedMs: 120000 }, '198.51.100.2')
      assert.equal(res.status, 200)
      const out = await res.json()
      assert.equal(out.ok, true)
      assert.equal(out.filed, 'application')
      assert.match(out.reference, /^CS-APP-/)
      assert.equal(f.calls.length, 1)
      assert.match(f.calls[0].url, /\/api\/site-application$/)
      assert.ok(f.calls[0].init.headers['x-cs-commission-signature'])
      const sent = JSON.parse(f.calls[0].init.body)
      assert.equal(sent.posting, 'brand-architect-intern')
      assert.equal(sent.reference, out.reference)
      assert.equal(sent.answers.bai_brief, 'Start with the regulars.')
    } finally { f.restore() }
  })
})

test('the workspace’s answer decides what it was filed as (an early application is kept as interest)', async () => {
  await withSecret(async () => {
    const f = stubFetch(200, { received: true, filed: 'interest' })
    try {
      const out = await (await post({ posting: 'brand-architect-intern', answers: GOOD, elapsedMs: 120000 }, '198.51.100.3')).json()
      assert.equal(out.filed, 'interest')
    } finally { f.restore() }
  })
})

test('a workspace that cannot take it yet means HELD — never lost, never a failure to the person', async () => {
  await withSecret(async () => {
    const f = stubFetch(503, { error: 'not provisioned' })
    try {
      const out = await (await post({ posting: 'brand-architect-jr', kind: 'interest', answers: { full_name: 'Sam', email: 'sam@example.com' }, elapsedMs: 9000 }, '198.51.100.4')).json()
      assert.equal(out.ok, true)
      assert.equal(out.filed, 'interest')
      assert.equal(f.calls.length, 3, 'three tries before holding')
    } finally { f.restore() }
  })
})

test('a missing answer is a 400 that names the field', async () => {
  const { bai_why: _w, ...short } = GOOD
  const res = await post({ posting: 'brand-architect-intern', answers: short, elapsedMs: 120000 }, '198.51.100.5')
  assert.equal(res.status, 400)
  assert.equal((await res.json()).field, 'bai_why')
})

test('the fifth application from one address in an hour is the last', async () => {
  await withSecret(async () => {
    const f = stubFetch(200, { received: true, filed: 'application' })
    try {
      for (let i = 0; i < 5; i += 1) assert.equal((await post({ posting: 'brand-architect-intern', answers: GOOD, elapsedMs: 120000 }, '198.51.100.6')).status, 200)
      assert.equal((await post({ posting: 'brand-architect-intern', answers: GOOD, elapsedMs: 120000 }, '198.51.100.6')).status, 429)
    } finally { f.restore() }
  })
})

/* ── the pages ───────────────────────────────────────────────────────── */

const page = (p) => readFileSync(new URL(`../../public/${p}`, import.meta.url), 'utf8')

test('every careers page is in the sitemap and routed, and each posting page mounts its own form', () => {
  const sitemap = page('sitemap.xml')
  for (const p of ['careers/', 'careers/brand-architect-intern/', 'careers/brand-architect-jr/', 'careers/content-creator/', 'careers/social-strategist/']) {
    assert.ok(sitemap.includes(`https://createspacebrand.com/${p}</loc>`), `${p} is not in the sitemap`)
  }
  for (const p of POSTINGS) {
    const html = page(`careers/${p.slug}/index.html`)
    assert.ok(html.includes(`data-careers-form="${p.slug}"`), `${p.slug} does not mount its form`)
    assert.ok(html.includes('/assets/careers.js'), `${p.slug} does not load careers.js`)
    assert.ok(html.includes(`<link rel="canonical" href="https://createspacebrand.com/careers/${p.slug}/" />`))
    assert.ok(!/Createspace Talent/.test(html), 'never the parent name')
  }
  const toml = readFileSync(new URL('../../netlify.toml', import.meta.url), 'utf8')
  assert.ok(toml.includes('from = "/api/careers"'))
  assert.ok(toml.includes('from = "/api/careers-postings"'))
})

test('a posting that is not open carries no JobPosting schema (the playbook: nothing when it is not)', () => {
  const jr = page('careers/brand-architect-jr/index.html')
  assert.ok(!jr.includes('"JobPosting"'), 'the Jr. seat opens in November')
  const intern = page('careers/brand-architect-intern/index.html')
  assert.ok(intern.includes('"JobPosting"'))
  assert.ok(intern.includes('"TELECOMMUTE"'))
  const creator = page('careers/content-creator/index.html')
  assert.ok(creator.includes('"JobPosting"'), 'the content creator posting is open')
  assert.ok(creator.includes('"CONTRACTOR"'))
})

test('the content creator posting names no rate and no term — both come after the first stage', () => {
  const html = page('careers/content-creator/index.html')
  assert.doesNotMatch(html, /\$\d|baseSalary|per month|a month for/i, 'the rate is discussed after the application, never posted')
  assert.doesNotMatch(html, /3-month|three-month|1-month|one-month/i, 'the term is not posted')
  assert.match(html, /7–10 seconds/)
  const creatorCard = page('careers/index.html').match(/<a class="role-card" href="\/careers\/content-creator\/">[\s\S]*?<\/a>/)
  assert.ok(creatorCard, 'the content creator has a careers card')
  assert.doesNotMatch(creatorCard[0], /\$\d/, 'the careers card names no rate')
  assert.doesNotMatch(readFileSync(new URL('../../public/assets/careers-core.mjs', import.meta.url), 'utf8'), /\$\d/, 'nor does the form')
  const card = page('careers/index.html')
  assert.ok(card.includes('href="/careers/content-creator/"'))
  assert.ok(card.includes('data-posting-badge="content-creator"'))
})

test('the social strategist posting is open, links from the careers page, and mounts its form', () => {
  const html = page('careers/social-strategist/index.html')
  assert.ok(html.includes('"JobPosting"'), 'the social strategist posting is open')
  assert.ok(html.includes('"CS-REQ-STR-01"'))
  assert.ok(!/Trends Strategist/.test(html), 'the seat is the Social Strategist')
  const card = page('careers/index.html')
  assert.ok(card.includes('href="/careers/social-strategist/"'))
  assert.ok(card.includes('data-posting-badge="social-strategist"'))
})

test('the social strategist posting shows its starting pay — on the page, its card, and its job data', () => {
  const html = page('careers/social-strategist/index.html')
  assert.match(html, /<span>Pay<\/span><span>Starts at \$20 an hour<\/span>/)
  const job = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1])['@graph'].find((n) => n['@type'] === 'JobPosting')
  assert.deepEqual(job.baseSalary, { '@type': 'MonetaryAmount', currency: 'USD', value: { '@type': 'QuantitativeValue', minValue: 20, unitText: 'HOUR' } })
  const card = page('careers/index.html').match(/<a class="role-card" href="\/careers\/social-strategist\/">[\s\S]*?<\/a>/)
  assert.match(card[0], /From \$20 an hour/)
})

// The service-fit assessment: the page and the desk score the same file, and
// the copy that file carries mirrors the catalog.
import test from 'node:test'
import assert from 'node:assert/strict'
import { QUESTIONS, SERVICE_ORDER, SERVICE_COPY, score, readAnswers, complete, servicePath } from '../../public/assets/assessment-core.mjs'
import { SERVICES, SERVICE_IDS } from './services.mjs'
import { readAssessment } from '../functions/assessment.mjs'

test('the assessment names exactly the catalogue, with the catalogue’s own words', () => {
  assert.deepEqual([...SERVICE_ORDER].sort(), [...SERVICE_IDS].sort())
  for (const id of SERVICE_IDS) {
    assert.equal(SERVICE_COPY[id].name, SERVICES[id].name, `${id}: name`)
    assert.equal(SERVICE_COPY[id].tier, SERVICES[id].tier, `${id}: tier`)
    assert.equal(SERVICE_COPY[id].turnaround, SERVICES[id].turnaround, `${id}: turnaround`)
    assert.equal(SERVICE_COPY[id].blurb, SERVICES[id].blurb, `${id}: blurb`)
    assert.ok(SERVICE_COPY[id].fits.length > 40, `${id}: says when it fits`)
  }
})

test('every option only ever points at a real service, and every question has distinct keys', () => {
  for (const q of QUESTIONS) {
    const keys = q.options.map((o) => o.key)
    assert.equal(new Set(keys).size, keys.length, `${q.id}: duplicate option key`)
    for (const o of q.options) {
      assert.ok(o.label && o.because, `${q.id}/${o.key}: label and because`)
      for (const k of Object.keys(o.adds)) assert.ok(SERVICE_ORDER.includes(k), `${q.id}/${o.key} adds to unknown service ${k}`)
    }
  }
})

test('nothing is scored until every question is answered', () => {
  assert.equal(score({}), null)
  assert.equal(score({ where: 'starting' }), null)
  assert.equal(complete(readAnswers({ where: 'starting', change: 'nonsense' })), false)
})

test('a coherent set of answers lands where it should, with reasons quoted back', () => {
  const shop = score({ where: 'selling', change: 'money', how: 'forme', horizon: 'fortnight', ache: 'shop', visual: 'sell', lead: 'beautiful' })
  assert.equal(shop.recommended, 'storefront-buildout')
  assert.ok(shop.reasons.length >= 2 && shop.reasons.length <= 3)
  assert.ok(shop.reasons.includes('you have offers and no storefront'))

  const ideas = score({ where: 'inconsistent', change: 'plan', how: 'research', horizon: 'week', ache: 'ideas', visual: 'fine', lead: 'audience' })
  assert.equal(ideas.recommended, 'engagement-action-plan')
  assert.equal(ideas.secondary, 'social-strategy-sprint')

  const systems = score({ where: 'onfire', change: 'plan', how: 'teach', horizon: 'month', ache: 'tools', visual: 'fine', lead: 'work' })
  assert.equal(systems.recommended, 'organizational-systems')

  const arch = score({ where: 'starting', change: 'decision', how: 'withme', horizon: 'season', ache: 'who', visual: 'fine', lead: 'me' })
  assert.equal(arch.recommended, 'brand-architecture')
})

test('every service is somebody’s answer — no option set can never win', () => {
  const winners = new Set()
  const walk = (i, acc) => {
    if (i === QUESTIONS.length) { winners.add(score(acc).recommended); return }
    for (const o of QUESTIONS[i].options) walk(i + 1, { ...acc, [QUESTIONS[i].id]: o.key })
  }
  walk(0, {})
  for (const id of SERVICE_ORDER) assert.ok(winners.has(id), `${id} can never be recommended`)
})

test('ties fall to the fixed-price tier, in catalogue order', () => {
  // A deliberately flat set: "done for me" adds one point to four services.
  const r = score({ where: 'starting', change: 'look', how: 'forme', horizon: 'month', ache: 'profile', visual: 'pieces', lead: 'beautiful' })
  assert.equal(r.recommended, 'visual-brand-kit')
  assert.equal(SERVICE_COPY[r.recommended].tier, '03')
})

test('the result points at the shelf, opened on the service', () => {
  assert.equal(servicePath('creator-intensive'), '/shop/services/#creator-intensive')
})

/* ── the desk's reading of a submission ─────────────────────────────────── */

const GOOD = {
  name: 'Ada Lovelace', email: 'ADA@Example.com ', handle: 'https://www.instagram.com/ada.makes/',
  consent: true,
  answers: { where: 'selling', change: 'money', how: 'forme', horizon: 'fortnight', ache: 'shop', visual: 'sell', lead: 'beautiful' },
}

test('readAssessment needs a name, a working email and every answer', () => {
  assert.ok(readAssessment({ ...GOOD, name: '' }).error)
  assert.ok(readAssessment({ ...GOOD, email: 'ada@' }).error)
  assert.ok(readAssessment({ ...GOOD, answers: { ...GOOD.answers, lead: '' } }).error)
  const { error, submission } = readAssessment(GOOD)
  assert.equal(error, undefined)
  assert.equal(submission.email, 'ada@example.com')
  assert.equal(submission.handle, 'https://www.instagram.com/ada.makes/')
  assert.equal(submission.result.recommended, 'storefront-buildout')
})

test('consent is a literal true — a string, a 1, an on, are all a no', () => {
  for (const v of ['true', 1, 'on', 'yes']) assert.equal(readAssessment({ ...GOOD, consent: v }).submission.consent, false)
  assert.equal(readAssessment({ ...GOOD, consent: true }).submission.consent, true)
  assert.equal(readAssessment({ ...GOOD, consent: undefined }).submission.consent, false)
})

test('the desk scores the answers itself and ignores any result the browser sent', () => {
  const { submission } = readAssessment({ ...GOOD, result: { recommended: 'brand-architecture' } })
  assert.equal(submission.result.recommended, 'storefront-buildout')
})

/* ── the door itself ─────────────────────────────────────────────────────── */

import handler from '../functions/assessment.mjs'

const post = (body, ip = '203.0.113.7') =>
  handler(new Request('https://createspacebrand.com/api/assessment', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), { ip })

const stubFetch = (status, json = {}) => {
  const calls = []
  const prev = globalThis.fetch
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); return new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } }) }
  return { calls, restore: () => { globalThis.fetch = prev } }
}

test('a filled honeypot or a three-second fill is thanked and thrown away', async () => {
  const f = stubFetch(200)
  try {
    const a = await post({ ...GOOD, website: 'http://spam', elapsedMs: 9000 })
    assert.equal(a.status, 200)
    assert.equal((await a.json()).result, null)
    const b = await post({ ...GOOD, elapsedMs: 900 })
    assert.equal((await b.json()).result, null)
    assert.equal(f.calls.length, 0, 'nothing crossed the bridge')
  } finally { f.restore() }
})

test('a real submission is scored on the desk, crosses the bridge with the tick, and answers without waiting on mail', async () => {
  const env = process.env.SERVICE_BRIDGE_SECRET
  process.env.SERVICE_BRIDGE_SECRET = 'test-secret'
  const f = stubFetch(200, { ok: true })
  try {
    const res = await post({ ...GOOD, elapsedMs: 45000 }, '203.0.113.8')
    assert.equal(res.status, 200)
    const out = await res.json()
    assert.equal(out.ok, true)
    assert.equal(out.result.recommended, 'storefront-buildout')
    assert.equal(out.list, 'joined')
    assert.equal(out.copy, false, 'no mailbox is configured under test — and that is not an error')
    assert.match(out.reference, /^CS-FIT-/)
    assert.equal(f.calls.length, 1)
    assert.match(f.calls[0].url, /\/api\/list-signup$/)
    const sent = JSON.parse(f.calls[0].init.body)
    assert.equal(sent.consent, true)
    assert.equal(sent.email, 'ada@example.com')
    assert.equal(sent.source, 'assessment')
    assert.equal(sent.assessment.recommended, 'storefront-buildout')
    assert.ok(sent.tags.includes('storefront-buildout'))
    assert.ok(f.calls[0].init.headers['x-cs-commission-signature'])
  } finally { f.restore(); if (env === undefined) delete process.env.SERVICE_BRIDGE_SECRET; else process.env.SERVICE_BRIDGE_SECRET = env }
})

test('without the tick nothing crosses the bridge, and the fit is still theirs', async () => {
  const f = stubFetch(200, { ok: true })
  try {
    const out = await (await post({ ...GOOD, consent: false, elapsedMs: 45000 }, '203.0.113.9')).json()
    assert.equal(out.ok, true)
    assert.equal(out.list, 'declined')
    assert.equal(out.result.recommended, 'storefront-buildout')
    assert.equal(f.calls.length, 0)
  } finally { f.restore() }
})

test('a workspace that cannot take the signup yet means HELD, never lost and never a failure to the person', async () => {
  const env = process.env.SERVICE_BRIDGE_SECRET
  process.env.SERVICE_BRIDGE_SECRET = 'test-secret'
  const f = stubFetch(503, { error: 'run reference/sql/mailing-list.sql' })
  try {
    const out = await (await post({ ...GOOD, elapsedMs: 45000 }, '203.0.113.10')).json()
    assert.equal(out.ok, true)
    assert.equal(out.list, 'held')
    assert.equal(f.calls.length, 3, 'three tries before holding')
  } finally { f.restore(); if (env === undefined) delete process.env.SERVICE_BRIDGE_SECRET; else process.env.SERVICE_BRIDGE_SECRET = env }
})

test('a missing answer is a 400 with a sentence, not a 500', async () => {
  const res = await post({ ...GOOD, answers: { ...GOOD.answers, lead: 'nope' }, elapsedMs: 45000 }, '203.0.113.11')
  assert.equal(res.status, 400)
  assert.match((await res.json()).error, /answers went missing/)
})

// POST /api/scope-request — "request the scope of work", which is not a
// contact form.
//
// The other door into the Service Line. A tier-04 service is scoped in writing
// before a price exists (the catalog's own rule), which used to mean: a form,
// an inbox, a person, a call, a week. Now it means an engagement opens on the
// desk inside a minute, the client's assessment is with them before they close
// the tab, and the written scope that comes back is built on their own answers
// rather than on what somebody remembered from the call.
//
// Nothing is charged and nothing is promised about a price. What the client is
// promised is the thing they actually asked for: a written scope of work.
//
// The guards are the inquiry form's, because they work: a honeypot, a minimum
// fill time, and a per-IP ceiling.
import { randomBytes } from 'node:crypto'
import { SERVICES } from '../shared/services.mjs'
import { deliverCommission, flushOutbox } from '../shared/commission.mjs'
import { sendMail, mailbox, esc } from '../shared/mail.mjs'
import { clean } from '../shared/catalog.mjs'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const str = (v, max) => String(v ?? '').trim().slice(0, max)

const WINDOW_MS = 60 * 60 * 1000
const MAX_PER_WINDOW = 5
const memoryHits = new Map()

async function overLimit(ip) {
  const now = Date.now()
  try {
    const { getStore } = await import('@netlify/blobs')
    const store = getStore('scope-rate')
    const hits = ((await store.get(ip, { type: 'json' })) || []).filter((t) => now - t < WINDOW_MS)
    if (hits.length >= MAX_PER_WINDOW) return true
    hits.push(now)
    await store.setJSON(ip, hits)
    return false
  } catch {
    const hits = (memoryHits.get(ip) || []).filter((t) => now - t < WINDOW_MS)
    if (hits.length >= MAX_PER_WINDOW) return true
    hits.push(now)
    memoryHits.set(ip, hits)
    return false
  }
}

const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'
function reference() {
  const bytes = randomBytes(6)
  let tail = ''
  for (const b of bytes) tail += ALPHABET[b % ALPHABET.length]
  return `CS-SCOPE-${new Date().getUTCFullYear()}-${tail}`
}

/** Validate and shape. Pure, so the shape is testable without a request. */
export function readScopeRequest(body = {}) {
  const request = {
    service: str(body.service, 64),
    name: str(body.name, 120),
    email: str(body.email, 200).toLowerCase(),
    handle: str(body.handle, 120).replace(/^@/, ''),
    platform: str(body.platform, 60),
    niche: str(body.niche, 160),
    goal: str(body.goal, 3000),
    timing: str(body.timing, 60),
    budget: str(body.budget, 60),
  }
  if (!SERVICES[request.service]) return { error: 'Choose which service you would like scoped.' }
  if (SERVICES[request.service].tier !== '04') {
    // A tier-03 build has a published price and a checkout. Sending somebody
    // down the scoping road for one would be slower for them and no more
    // honest for us.
    return { error: `${SERVICES[request.service].name} is already scoped and priced — you can book it directly.`, buyable: true }
  }
  if (!request.name) return { error: 'Add your name — the scope is written for a person.' }
  if (!EMAIL_RE.test(request.email)) return { error: "That email doesn't look complete — it's where the scope goes." }
  if (request.goal.length < 20) return { error: 'Tell us in a sentence or two what you want this to change. The plain version is the useful one.' }
  return { request }
}

export default async (req, context) => {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 })

  let body = {}
  try { body = await req.json() } catch { /* handled below */ }

  // The honeypot and the minimum fill time. A bot fills every field it finds
  // and submits in under three seconds; a person does neither.
  if (str(body.company_website, 200)) return Response.json({ ok: true })
  const elapsed = Number(body.elapsed)
  if (Number.isFinite(elapsed) && elapsed < 3000) return Response.json({ ok: true })

  const { request, error, buyable } = readScopeRequest(body)
  if (error) return Response.json({ error, buyable: Boolean(buyable) }, { status: 400 })

  const ip = context?.ip || req.headers.get('x-nf-client-connection-ip') || req.headers.get('x-forwarded-for') || 'unknown'
  if (await overLimit(ip)) {
    return Response.json({ error: "That's a few in quick succession — give it a little while, or write to us directly." }, { status: 429 })
  }

  const service = SERVICES[request.service]
  const ref = reference()

  // What they typed here travels as ANSWERS, keyed by the question, so the
  // desk's assessment never asks them the same thing twice. Half the intake is
  // already done before the client opens it, which is exactly the point.
  const answers = {
    'What do you want this engagement to change for you?': request.goal,
    ...(request.niche ? { 'Your niche, in your own words': request.niche } : {}),
    ...(request.handle ? { 'Your primary platform (and handle)': [request.platform, request.handle && `@${request.handle}`].filter(Boolean).join(' · ') } : {}),
  }

  const commission = {
    reference: ref,
    kind: 'scope',
    serviceKey: service.serviceKey,
    serviceName: service.name,
    tier: service.tier,
    amount: 0,
    currency: 'usd',
    payment: 'full',
    paidAt: '',
    client: {
      name: request.name,
      email: request.email,
      handle: request.handle,
      platform: request.platform,
      niche: request.niche,
      member: false,
    },
    addons: [],
    discountPct: 0,
    answers,
    notes: [request.timing && `Timing: ${request.timing}`, request.budget && `Budget band: ${request.budget}`].filter(Boolean).join('\n'),
    source: 'createspacebrand.com',
    origin: 'scope-request',
  }

  const sent = await deliverCommission(commission)
  // A working bridge is the best moment to clear anything that was held while
  // it was not working, and it costs one extra round trip on a quiet endpoint.
  if (sent.ok) flushOutbox({ limit: 5 }).catch(() => {})

  // The desk hears either way — the workspace's own notice covers the happy
  // path, and this covers the one where the bridge is down and somebody would
  // otherwise be waiting on a scope nobody knows was asked for.
  if (!sent.ok && mailbox()) {
    await sendMail({
      to: null,
      replyTo: request.email,
      subject: `HELD · scope request — ${service.name} — ${request.name}`,
      text: `The bridge to the workspace refused this request, so it is held in the outbox and will retry.\n\nReason: ${sent.error}\nReference: ${ref}\n\n${request.name} <${request.email}>\n${service.name}\n\n${request.goal}`,
      html: `<div style="font-family:Arial,sans-serif"><p><b>Held.</b> ${esc(sent.error || 'the workspace did not answer')}</p><p>${esc(ref)} · ${esc(service.name)}<br>${esc(request.name)} &lt;${esc(request.email)}&gt;</p><p style="white-space:pre-wrap">${esc(request.goal)}</p></div>`,
    }).catch(() => {})
  }

  console.log('scope-request:', ref, service.serviceKey, sent.ok ? `opened as ${sent.code || 'ok'}` : `HELD — ${sent.error}`)

  return Response.json({
    ok: true,
    reference: ref,
    service: { id: request.service, name: service.name, turnaround: service.turnaround },
    // Honest either way. When the bridge is up the client really does get
    // their assessment in the next minute; when it is held, saying so would be
    // a promise we cannot keep, so the page says the slower true thing.
    opened: Boolean(sent.ok),
    message: sent.ok
      ? 'Your assessment is on its way — check your inbox in the next minute or two.'
      : `We have your request. We'll be in touch shortly with your assessment.${clean(process.env.CONTEXT) === 'production' ? '' : ' (bridge held)'}`,
  })
}

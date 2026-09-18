// The service-fit assessment behind /assessment/ — seven answers, a name and
// an email in; the fit out, a copy to their inbox, a note to the desk, and
// (with their tick) the person onto the mailing list.
//
// Conventions (honeypot, minimum fill time, per-IP limit) are the inquiry's.
// The answers are scored HERE, from the same file the page scores with
// (public/assets/assessment-core.mjs); any result the browser sent is
// ignored. The list signup crosses the signed bridge in netlify/shared/list.mjs
// and is held in an outbox if the workspace cannot take it yet. Mail is
// best-effort on both sides: the result on the page and the row on the list
// are the two things this door exists for, and neither waits on SMTP.
import { sendMail, mailbox, esc } from '../shared/mail.mjs'
import { clean } from '../shared/catalog.mjs'
import { signupFrom, deliverSignup, flushListOutbox, CONSENT_TEXT } from '../shared/list.mjs'
import { QUESTIONS, SERVICE_COPY, score, readAnswers, servicePath } from '../../public/assets/assessment-core.mjs'

const SITE = 'https://createspacebrand.com'
const str = (v, max) => String(v ?? '').trim().slice(0, max)
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const WINDOW_MS = 60 * 60 * 1000
const MAX_PER_WINDOW = 8
const memoryHits = new Map()

async function overLimit(ip) {
  const now = Date.now()
  try {
    const { getStore } = await import('@netlify/blobs')
    const store = getStore('assessment-rate')
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

/** Pure: validate + shape the submission. `{ error }` or `{ submission }`. */
export function readAssessment(body = {}) {
  const name = str(body.name, 120)
  const email = str(body.email, 200).toLowerCase()
  const handle = str(body.handle, 200)
  const answers = readAnswers(body.answers || {})
  const result = score(answers)
  if (!name || !email) return { error: 'Your name and email are the only two things we need to send the result.' }
  if (!EMAIL_RE.test(email)) return { error: "That email doesn't look complete — mind checking it?" }
  if (!result) return { error: 'One of the seven answers went missing — go back and pick it again.' }
  return { submission: { name, email, handle, consent: body.consent === true, answers: result.answers, result } }
}

const reference = () => `CS-FIT-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`

const optionLabel = (qid, key) => {
  const q = QUESTIONS.find((x) => x.id === qid)
  const o = q?.options.find((x) => x.key === key)
  return o ? o.label : key
}

const rowsHtml = (rows) =>
  rows
    .map(
      ([k, v]) => `<tr>
          <td style="padding: 10px 16px; font-size: 12px; color: rgba(78,49,44,0.55); border-bottom: 1px solid rgba(78,49,44,0.10); white-space: nowrap; vertical-align: top;">${esc(k)}</td>
          <td style="padding: 10px 16px; font-size: 14px; border-bottom: 1px solid rgba(78,49,44,0.10);">${esc(v)}</td>
        </tr>`
    )
    .join('')

const listLine = (list) =>
  ({ joined: 'Joined the list (their own tick)', held: 'Joined the list — HELD in the outbox until the workspace takes it', refused: 'Joined the list — the workspace REFUSED it (check SERVICE_BRIDGE_SECRET)', declined: 'Did not join the list' })[list] || list

/** The desk copy: who, what they answered, where it landed. */
export function renderDeskMail(s, { ref, list }) {
  const top = SERVICE_COPY[s.result.recommended]
  const second = SERVICE_COPY[s.result.secondary]
  const rows = [
    ['Name', s.name],
    ['Email', s.email],
    ['Handle', s.handle || '—'],
    ['Their fit', `${top.name} (tier ${top.tier}, ${top.turnaround})`],
    ['Runner-up', `${second.name} (tier ${second.tier})`],
    ['The list', listLine(list)],
    ['Reference', ref],
    ...QUESTIONS.map((q) => [q.ask, optionLabel(q.id, s.answers[q.id])]),
  ]
  const text = rows.map(([k, v]) => `${k}: ${v}`).join('\n')
  const html = `
    <div style="font-family: Arial, sans-serif; color: #4E312C; background: #FFFFF0; padding: 28px;">
      <p style="font-size: 11px; font-weight: bold; letter-spacing: 2px; text-transform: uppercase; color: #567363; margin: 0 0 14px;">Service fit &middot; createspacebrand.com/assessment</p>
      <table style="border-collapse: collapse; background: #FFFFFF; border: 1px solid rgba(78,49,44,0.14); border-radius: 12px; width: 100%; max-width: 640px;">${rowsHtml(rows)}</table>
      <p style="font-size: 12px; color: rgba(78,49,44,0.55); margin: 16px 0 0;">Reply goes straight to them — reply-to is set to their address.</p>
    </div>`
  return { text, html }
}

/** The person's copy: the fit, why, the first step, the runner-up. */
export function renderResultMail(s) {
  const first = s.name.split(/\s+/)[0]
  const top = SERVICE_COPY[s.result.recommended]
  const second = SERVICE_COPY[s.result.secondary]
  const link = `${SITE}${servicePath(s.result.recommended)}`
  const why = s.result.reasons.map((r) => `because ${r}`).join('; ')
  const text = `Hi ${first},

Your fit is the ${top.name} — ${top.blurb}

Why this one: ${why}.

${top.fits}

First step: ${top.first}
${link}

The runner-up was the ${second.name} — ${second.blurb} ${SITE}${servicePath(s.result.secondary)}
${s.consent ? `\nYou're on the createspace list — a few emails a season, and every one carries a link to leave.` : ''}
— createspace · community + talent
${SITE}
`
  const html = `
    <div style="font-family: Arial, sans-serif; color: #4E312C; background: #FFFFF0; padding: 28px;">
      <p style="font-size: 11px; font-weight: bold; letter-spacing: 2px; text-transform: uppercase; color: #567363; margin: 0 0 18px;">createspace &middot; your fit</p>
      <p style="font-size: 20px; font-weight: 300; margin: 0 0 6px;">Hi ${esc(first)} — your fit is the <b style="font-weight: 600;">${esc(top.name)}</b>.</p>
      <p style="font-size: 14px; line-height: 1.7; margin: 0 0 18px; max-width: 56ch;">${esc(top.blurb)} Tier ${esc(top.tier)} &middot; ${esc(top.turnaround)}.</p>
      <p style="font-size: 11px; font-weight: bold; letter-spacing: 2px; text-transform: uppercase; color: #567363; margin: 0 0 8px;">Why this one</p>
      <ul style="font-size: 14px; line-height: 1.7; margin: 0 0 18px; padding-left: 18px; max-width: 56ch;">${s.result.reasons.map((r) => `<li>because ${esc(r)}</li>`).join('')}</ul>
      <p style="font-size: 14px; line-height: 1.7; margin: 0 0 18px; max-width: 56ch;">${esc(top.fits)}</p>
      <p style="margin: 0 0 26px;"><a href="${esc(link)}" style="display: inline-block; background: #4E312C; color: #FFFFF0; text-decoration: none; padding: 12px 20px; border-radius: 999px; font-size: 13px; font-weight: 600;">${esc(top.first)}</a></p>
      <p style="font-size: 13px; line-height: 1.7; margin: 0 0 18px; max-width: 56ch; color: rgba(78,49,44,0.75);">The runner-up was the <a href="${esc(`${SITE}${servicePath(s.result.secondary)}`)}" style="color: #567363;">${esc(second.name)}</a> — ${esc(second.blurb)}</p>
      ${s.consent ? `<p style="font-size: 12px; color: rgba(78,49,44,0.55); margin: 0;">You're on the createspace list — a few emails a season, and every one carries a link to leave.</p>` : ''}
    </div>`
  return { text, html }
}

export default async (req, context) => {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 })

  let body = {}
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'Bad request' }, { status: 400 })
  }

  // Bot signals: a filled honeypot or a sub-3-second fill. Pretend success.
  const elapsedMs = Number(body.elapsedMs || 0)
  if (String(body.website || '') || (elapsedMs > 0 && elapsedMs < 3000)) {
    console.log('assessment: discarded as bot signals', { elapsedMs })
    return Response.json({ ok: true, result: null, list: 'declined' })
  }

  const { error, submission } = readAssessment(body)
  if (error) return Response.json({ error }, { status: 400 })

  const ip = context?.ip || req.headers.get('x-nf-client-connection-ip') || req.headers.get('x-forwarded-for') || 'unknown'
  if (await overLimit(ip)) {
    return Response.json({ error: "That's a few in quick succession — give it a little while and try again." }, { status: 429 })
  }

  const ref = reference()
  const takenAt = new Date().toISOString()
  const r = submission.result

  // The list — only with their tick. Held, never lost, if the workspace is away.
  let list = 'declined'
  if (submission.consent) {
    const out = await deliverSignup(
      signupFrom({
        reference: ref, email: submission.email, name: submission.name, handle: submission.handle, consent: true,
        source: 'assessment', tags: ['assessment', r.recommended],
        assessment: { recommended: r.recommended, secondary: r.secondary, answers: r.answers, scores: r.scores, takenAt },
      }),
    )
    list = out.ok ? 'joined' : out.held ? 'held' : 'refused'
    if (out.ok) await flushListOutbox({ limit: 10 }).catch(() => {})
  }

  // Mail, best-effort: the desk first, then the person.
  const box = mailbox()
  if (box) {
    const desk = renderDeskMail(submission, { ref, list })
    await sendMail({
      to: clean(process.env.INQUIRY_EMAIL) || box.to,
      replyTo: { name: submission.name, address: submission.email },
      subject: `Service fit — ${submission.name} → ${SERVICE_COPY[r.recommended].name}`,
      text: desk.text,
      html: desk.html,
    })
    const mine = renderResultMail(submission)
    await sendMail({
      to: { name: submission.name, address: submission.email },
      replyTo: { name: box.fromName, address: clean(process.env.INQUIRY_EMAIL) || box.to },
      subject: `Your fit: the ${SERVICE_COPY[r.recommended].name} — createspace`,
      text: mine.text,
      html: mine.html,
    })
  }

  return Response.json({
    ok: true,
    reference: ref,
    result: { recommended: r.recommended, secondary: r.secondary, reasons: r.reasons, scores: r.scores },
    list,
    copy: Boolean(box),
    consentText: CONSENT_TEXT,
  })
}

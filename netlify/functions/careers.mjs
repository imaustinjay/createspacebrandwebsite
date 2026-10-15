// The careers door behind /careers/<posting>/ — an application (or "tell me
// when it opens") in; a row in the workspace's Talent Acquisition out, a copy
// to the careers desk, and a note to the person.
//
// Conventions (honeypot, minimum fill time, per-IP limit) are the inquiry's and
// the assessment's. The answers are read HERE with the same file the page reads
// them with (public/assets/careers-core.mjs) — whatever the browser decided is
// checked again. The application crosses the signed bridge in
// netlify/shared/careers.mjs and is held in an outbox if the workspace cannot
// take it yet. Mail is best-effort: the row in Talent Acquisition is the thing
// this door exists for, and it never waits on SMTP.
import { sendMail, mailbox, esc } from '../shared/mail.mjs'
import { clean } from '../shared/catalog.mjs'
import { careersReference, applicationFrom, deliverApplication, flushCareersOutbox } from '../shared/careers.mjs'
import { FORMS, postingFor, postingState, readCareers } from '../../public/assets/careers-core.mjs'

const SITE = 'https://createspacebrand.com'
const WINDOW_MS = 60 * 60 * 1000
const MAX_PER_WINDOW = 5
const memoryHits = new Map()

async function overLimit(ip) {
  const now = Date.now()
  try {
    const { getStore } = await import('@netlify/blobs')
    const store = getStore('careers-rate')
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

const bridgeLine = (b) =>
  ({ delivered: 'In Talent Acquisition', held: 'HELD in the outbox until the workspace takes it', refused: 'The workspace REFUSED it (check SERVICE_BRIDGE_SECRET) — this email is the only copy' })[b] || b

/** The desk copy: the posting, every answer by its label, and where it landed. */
export function renderDeskMail(s, { ref, bridge, filed }) {
  const posting = postingFor(s.posting)
  const labels = Object.fromEntries((FORMS[s.posting] || []).flatMap((c) => c.fields.map((f) => [f.id, f.label])))
  const rows = [
    ['Posting', `${posting.role}${posting.cohort ? ` · ${posting.cohort}` : ''}`],
    ['Filed as', filed === 'interest' ? 'Interest — tell me when it opens' : 'Application'],
    ['Where it is', bridgeLine(bridge)],
    ['Reference', ref],
    ...Object.entries(s.answers).map(([k, v]) => [labels[k] || (k === 'note' ? 'Note' : k), Array.isArray(v) ? v.join(', ') : v]),
  ]
  const text = rows.map(([k, v]) => `${k}: ${v}`).join('\n')
  const html = `
    <div style="font-family: Arial, sans-serif; color: #4E312C; background: #FFFFF0; padding: 28px;">
      <p style="font-size: 11px; font-weight: bold; letter-spacing: 2px; text-transform: uppercase; color: #567363; margin: 0 0 14px;">Careers &middot; ${esc(posting.role)}</p>
      <table style="border-collapse: collapse; background: #FFFFFF; border: 1px solid rgba(78,49,44,0.14); border-radius: 12px; width: 100%; max-width: 680px;">${rows
        .map(([k, v]) => `<tr><td style="padding: 10px 16px; font-size: 12px; color: rgba(78,49,44,0.55); border-bottom: 1px solid rgba(78,49,44,0.10); vertical-align: top; width: 34%;">${esc(k)}</td><td style="padding: 10px 16px; font-size: 14px; border-bottom: 1px solid rgba(78,49,44,0.10); white-space: pre-wrap;">${esc(v)}</td></tr>`)
        .join('')}</table>
      <p style="font-size: 12px; color: rgba(78,49,44,0.55); margin: 16px 0 0;">Reply goes straight to them — reply-to is set to their address. Review it in the workspace: Talent Acquisition.</p>
    </div>`
  return { text, html }
}

/** The person's note: received, what happens next, and nothing promised. */
export function renderApplicantMail(s, { ref, filed }) {
  const posting = postingFor(s.posting)
  const first = s.name.split(/\s+/)[0]
  const page = `${SITE}/careers/${posting.slug}/`
  const body = filed === 'interest'
    ? [`Hi ${first},`, `Thank you — you're on the list for the ${posting.role} posting. The day applications open, we'll write to this address with the link.`, `Until then, the page has everything we know about the role: ${page}`]
    : [`Hi ${first},`, `Thank you for applying for ${posting.role}${posting.cohort ? `, ${posting.cohort}` : ''}. Your application is with us, and a person reads every one by hand.`, `What happens next: if it resonates, we'll write to set up a conversation. Either way, you'll hear from us — nobody is left wondering.`, `Your reference is ${ref}.`]
  const text = `${body.join('\n\n')}\n\n— createspace · community + talent\n${SITE}\n`
  const html = `
    <div style="font-family: Arial, sans-serif; color: #4E312C; background: #FFFFF0; padding: 28px;">
      <p style="font-size: 11px; font-weight: bold; letter-spacing: 2px; text-transform: uppercase; color: #567363; margin: 0 0 18px;">createspace &middot; careers</p>
      ${body.map((p) => `<p style="font-size: 15px; line-height: 1.7; margin: 0 0 14px; max-width: 56ch;">${esc(p)}</p>`).join('')}
      <p style="font-size: 13px; color: rgba(78,49,44,0.6); margin: 18px 0 0;">createspace · community + talent</p>
    </div>`
  return { text, html, subject: filed === 'interest' ? `You're on the list — ${posting.role}` : `We have your application — ${posting.role}` }
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
    console.log('careers: discarded as bot signals', { elapsedMs })
    return Response.json({ ok: true, filed: body.kind === 'interest' ? 'interest' : 'application' })
  }

  const { error, field, submission } = readCareers(body)
  if (error) return Response.json({ error, field }, { status: 400 })

  const ip = context?.ip || req.headers.get('x-nf-client-connection-ip') || req.headers.get('x-forwarded-for') || 'unknown'
  if (await overLimit(ip)) {
    return Response.json({ error: "That's a few in quick succession — give it a little while and try again." }, { status: 429 })
  }

  const ref = careersReference()
  const out = await deliverApplication(applicationFrom(submission, ref))
  const bridge = out.ok ? 'delivered' : out.held ? 'held' : 'refused'
  // The workspace decides application vs interest; when it could not be asked,
  // the page's own reading of the window stands in.
  const filed = out.ok ? out.filed : submission.kind === 'interest' || postingState(postingFor(submission.posting)) !== 'open' ? 'interest' : 'application'
  if (out.ok) await flushCareersOutbox({ limit: 10 }).catch(() => {})

  const box = mailbox()
  if (box) {
    const desk = renderDeskMail(submission, { ref, bridge, filed })
    const deskTo = clean(process.env.CAREERS_EMAIL) || clean(process.env.INQUIRY_EMAIL) || box.to
    await sendMail({
      to: deskTo,
      replyTo: { name: submission.name, address: submission.email },
      subject: `${filed === 'interest' ? 'Interest' : 'Application'} — ${postingFor(submission.posting).role} — ${submission.name}`,
      text: desk.text,
      html: desk.html,
    })
    const mine = renderApplicantMail(submission, { ref, filed })
    await sendMail({
      to: { name: submission.name, address: submission.email },
      replyTo: { name: box.fromName, address: deskTo },
      subject: mine.subject,
      text: mine.text,
      html: mine.html,
    })
  }

  return Response.json({ ok: true, reference: ref, filed, copy: Boolean(box) })
}

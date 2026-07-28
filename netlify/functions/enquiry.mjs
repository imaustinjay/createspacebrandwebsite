// Brand enquiry — the one serverless surface of the marketing site.
// Sends the enquiry to the partnerships mailbox. The destination address is an
// env var (PARTNERSHIPS_EMAIL) and is never echoed to the client, so it can't
// be scraped from the bundle or the API.
//
// SMTP credentials follow the workspace convention (shared/mailCore.mjs in the
// repo root): MAIL_USER/MAIL_PASSWORD preferred, TITAN_* as the legacy
// fallback, values cleaned of pasted quotes/whitespace.
import nodemailer from 'nodemailer'

const BUDGETS = {
  'under-5k': 'Under $5,000',
  '5-15k': '$5,000 – $15,000',
  '15-50k': '$15,000 – $50,000',
  '50k-plus': '$50,000+',
  unsure: 'Not sure yet',
}
const SOURCES = {
  creator: 'Through a creator',
  search: 'Search',
  social: 'Social',
  referral: 'A referral',
  other: 'Somewhere else',
}

// Env values arrive however they were pasted — strip wrapping quotes and edge
// whitespace, never interior content (same reasoning as shared/mailCore.mjs).
function clean(v) {
  if (typeof v !== 'string') return v
  let s = v.trim()
  if (s.length > 1 && ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'")))) {
    s = s.slice(1, -1).trim()
  }
  return s
}

const esc = (s = '') =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// Rate limiting: durable per-IP counter in Netlify Blobs when available, with
// an in-memory fallback (per warm instance) so local dev still has a guard.
const WINDOW_MS = 60 * 60 * 1000
const MAX_PER_WINDOW = 5
const memoryHits = new Map()

async function overLimit(ip) {
  const now = Date.now()
  try {
    const { getStore } = await import('@netlify/blobs')
    const store = getStore('enquiry-rate')
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

export default async (req, context) => {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 })

  let body = {}
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'Bad request' }, { status: 400 })
  }

  const name = String(body.name || '').trim().slice(0, 120)
  const email = String(body.email || '').trim().slice(0, 200)
  const company = String(body.company || '').trim().slice(0, 160)
  const budget = String(body.budget || '')
  const timing = String(body.timing || '').trim().slice(0, 200)
  const source = String(body.source || '')
  const honeypot = String(body.website || '')
  const elapsedMs = Number(body.elapsedMs || 0)

  // Bot signals: a filled honeypot or a sub-3-second fill. Pretend success so
  // the automation moves on with nothing learned; nothing is sent.
  if (honeypot || (elapsedMs > 0 && elapsedMs < 3000)) {
    return Response.json({ ok: true })
  }

  if (!name || !email || !company || !BUDGETS[budget]) {
    return Response.json(
      { error: 'Please fill in your name, work email, company, and a budget range.' },
      { status: 400 }
    )
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return Response.json({ error: "That email doesn't look complete — mind checking it?" }, { status: 400 })
  }

  const ip =
    context?.ip || req.headers.get('x-nf-client-connection-ip') || req.headers.get('x-forwarded-for') || 'unknown'
  if (await overLimit(ip)) {
    return Response.json(
      { error: "That's a few enquiries in quick succession — give it a little while and try again." },
      { status: 429 }
    )
  }

  const to = clean(process.env.PARTNERSHIPS_EMAIL)
  const user = clean(process.env.MAIL_USER || process.env.TITAN_EMAIL)
  const password = clean(process.env.MAIL_PASSWORD || process.env.TITAN_PASSWORD)
  if (!to || !user || !password) {
    return Response.json(
      { error: "The enquiry desk isn't connected yet. Give us a day and try again — we'd genuinely like to hear from you." },
      { status: 503 }
    )
  }

  const transporter = nodemailer.createTransport({
    host: clean(process.env.MAIL_SMTP_HOST || process.env.TITAN_SMTP_HOST) || 'smtp.titan.email',
    port: Number(clean(process.env.MAIL_SMTP_PORT || process.env.TITAN_SMTP_PORT)) || 465,
    secure: true,
    auth: { user, pass: password },
  })

  const rows = [
    ['Name', name],
    ['Work email', email],
    ['Company / brand', company],
    ['Budget range', BUDGETS[budget]],
    ['Timing', timing || '—'],
    ['How they found us', SOURCES[source] || '—'],
  ]
  const text = rows.map(([k, v]) => `${k}: ${v}`).join('\n')
  const html = `
    <div style="font-family: Arial, sans-serif; color: #4E312C; background: #FFFFF0; padding: 28px;">
      <p style="font-size: 11px; font-weight: bold; letter-spacing: 2px; text-transform: uppercase; color: #567363; margin: 0 0 14px;">Brand enquiry &middot; createspacebrand.com</p>
      <table style="border-collapse: collapse; background: #FFFFFF; border: 1px solid rgba(78,49,44,0.14); border-radius: 12px; width: 100%; max-width: 560px;">
        ${rows
          .map(
            ([k, v]) => `<tr>
          <td style="padding: 10px 16px; font-size: 12px; color: rgba(78,49,44,0.55); border-bottom: 1px solid rgba(78,49,44,0.10); white-space: nowrap;">${esc(k)}</td>
          <td style="padding: 10px 16px; font-size: 14px; border-bottom: 1px solid rgba(78,49,44,0.10);">${esc(v)}</td>
        </tr>`
          )
          .join('')}
      </table>
      <p style="font-size: 12px; color: rgba(78,49,44,0.55); margin: 16px 0 0;">Reply goes straight to the enquirer — reply-to is set to their address.</p>
    </div>`

  try {
    await transporter.sendMail({
      from: { name: clean(process.env.MAIL_FROM_NAME) || 'createspace · community + talent', address: user },
      to,
      replyTo: { name, address: email },
      subject: `Brand enquiry — ${company}`,
      text,
      html,
    })
    return Response.json({ ok: true })
  } catch {
    // Never leak SMTP detail (or the destination) to the public form.
    return Response.json(
      { error: "That didn't send — our side, not yours. Give it a moment and try again." },
      { status: 502 }
    )
  }
}

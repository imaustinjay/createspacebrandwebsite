// /api/account-auth — the customer door itself.
//
//   GET             → who am I: { in: false } or { in: true, user }
//   POST { action } → signup · login · logout · recover · reset
//
// The password crosses this function once, over TLS, on its way to Supabase —
// it is never logged, never stored here, and never appears in a response. What
// the browser gets back is a session in an HttpOnly cookie it cannot read.
//
// Rate-limited per IP the same way the checkout is, and for the same reason
// tuned loose: a person who typoes their password three times is a person,
// not an attack, and Supabase carries its own per-address limits underneath.
import {
  accountCookie,
  accountsState,
  clearAccountCookie,
  readTokens,
  recover,
  requireUser,
  resetPassword,
  signIn,
  signOut,
  signUp,
} from '../shared/customer-auth.mjs'
import { clientIp } from '../shared/admin-session.mjs'

const NO_STORE = { 'Cache-Control': 'no-store' }
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const WINDOW_MS = 60 * 60 * 1000
const MAX_PER_WINDOW = 30
const memoryHits = new Map()

async function overLimit(ip) {
  const now = Date.now()
  try {
    const { getStore } = await import('@netlify/blobs')
    const store = getStore('account-rate')
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

function siteOrigin(req) {
  const url = new URL(req.url)
  return /^(localhost|127\.0\.0\.1)/.test(url.hostname) ? url.origin : 'https://createspacebrand.com'
}

const say = (body, status = 200, headers = {}) =>
  Response.json(body, { status, headers: { ...NO_STORE, ...headers } })

export default async (req, context) => {
  // Who am I — read by every page that adapts to a signed-in visitor.
  if (req.method === 'GET') {
    const state = accountsState()
    if (!state.ok) return say({ in: false, reason: state.reason })
    const who = await requireUser(req)
    if (!who.ok) return say({ in: false })
    const headers = who.setCookie ? { 'Set-Cookie': accountCookie(who.setCookie, req) } : {}
    return say({ in: true, user: who.user }, 200, headers)
  }

  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 })

  let body
  try {
    body = await req.json()
  } catch {
    return say({ ok: false, message: 'That didn’t read as a request.' }, 400)
  }

  const action = String(body?.action || '')

  // Signing out needs no limit and no configuration — it only forgets.
  if (action === 'logout') {
    const held = readTokens(req)
    await signOut(held?.access)
    return say({ ok: true }, 200, { 'Set-Cookie': clearAccountCookie(req) })
  }

  const state = accountsState()
  if (!state.ok) {
    return say({ ok: false, reason: 'not-configured', message: 'Accounts aren’t connected yet — nothing was saved.' }, 503)
  }

  const ip = clientIp(req, context)
  if (await overLimit(ip)) {
    return say({ ok: false, message: 'Too many tries from here in an hour — give it a rest and come back.' }, 429)
  }

  const email = String(body?.email || '').trim().toLowerCase().slice(0, 200)
  const password = String(body?.password || '').slice(0, 200)

  if (action === 'signup' || action === 'login') {
    if (!EMAIL_RE.test(email)) return say({ ok: false, message: 'That email doesn’t look right.' }, 400)
    if (password.length < 10) return say({ ok: false, message: 'Passwords need at least 10 characters.' }, 400)
  }

  if (action === 'signup') {
    const kind = body?.kind === 'brand' ? 'brand' : 'customer'
    const name = String(body?.name || '').trim()
    const company = String(body?.company || '').trim()
    if (!name) return say({ ok: false, message: 'Add your name.' }, 400)
    if (kind === 'brand' && !company) return say({ ok: false, message: 'Add the brand or company name.' }, 400)

    const made = await signUp({ email, password, name, kind, company })
    if (!made.ok) return say({ ok: false, message: made.message }, 400)
    console.log('account: created', { kind, confirmed: made.state === 'in' })
    if (made.state === 'in') {
      return say({ ok: true, state: 'in', user: made.user }, 200, { 'Set-Cookie': accountCookie(made.session, req) })
    }
    return say({ ok: true, state: 'confirm' })
  }

  if (action === 'login') {
    const opened = await signIn({ email, password })
    if (!opened.ok) return say({ ok: false, reason: opened.reason, message: opened.message }, 401)
    return say({ ok: true, state: 'in', user: opened.user }, 200, { 'Set-Cookie': accountCookie(opened.session, req) })
  }

  if (action === 'recover') {
    if (!EMAIL_RE.test(email)) return say({ ok: false, message: 'That email doesn’t look right.' }, 400)
    const sent = await recover({ email, origin: siteOrigin(req) })
    if (!sent.ok) return say({ ok: false, message: sent.message }, 400)
    // The same sentence whether or not the address exists — a password form
    // must not double as a directory of who has an account.
    return say({ ok: true, message: 'If that address has an account, a reset link is on its way to it.' })
  }

  if (action === 'reset') {
    const token = String(body?.token || '').slice(0, 4000)
    if (!token) return say({ ok: false, message: 'That reset link didn’t carry its key — ask for a fresh one.' }, 400)
    if (password.length < 10) return say({ ok: false, message: 'Passwords need at least 10 characters.' }, 400)
    const set = await resetPassword({ token, password })
    if (!set.ok) return say({ ok: false, message: 'That link has expired — ask for a fresh one.' }, 400)
    return say({ ok: true, message: 'New password set — log in with it.' })
  }

  return say({ ok: false, message: 'Unknown action.' }, 400)
}

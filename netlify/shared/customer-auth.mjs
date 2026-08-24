// The customer door — one login for everything you buy, and the same login
// the workspace will recognise.
//
// Identity lives in Supabase Auth, on the same project the workspace already
// uses for its casting cycles and its creator portal. That is the whole
// decision: one person is one row, whether they bought a planner here or
// claimed a Collection seat over there. This site holds no user table of its
// own, so there is nothing to sync and nothing to drift.
//
// This module speaks to Supabase's auth API (GoTrue) over plain REST with the
// anon key — the same public pair `/api/seasons` already reads, no new
// secrets. The anon key can create and sign in users; what it can *read* is
// still governed entirely by row-level security, exactly as before.
//
// The session is Supabase's own token pair, carried in an HttpOnly cookie so
// no script on the page — ours, an extension's, or an injected one — can read
// it. The browser never sees an access token; every authenticated call goes
// through a function that unpacks the cookie server-side.
import { clean } from './catalog.mjs'

export const ACCOUNT_COOKIE = 'cs_account'

// Thirty days of not signing in again. The access token inside expires hourly
// and is refreshed silently; this is how long the refresh token gets carried.
const COOKIE_MAX_AGE = 30 * 24 * 60 * 60

function config() {
  const url = clean(process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL)
  const key = clean(process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY)
  if (!url || !key) return null
  return { url: url.replace(/\/+$/, ''), key }
}

// { ok } · { ok: false, reason: 'not-configured' } — one answer to "can
// anyone have an account", so the page can say so instead of erroring.
export function accountsState() {
  return config() ? { ok: true } : { ok: false, reason: 'not-configured' }
}

// One call to GoTrue. Returns { status, body } and never throws — an auth
// door that 500s on a network blip teaches people to mistrust the door.
async function gotrue(path, { method = 'POST', token, body } = {}) {
  const cfg = config()
  if (!cfg) return { status: 0, body: { reason: 'not-configured' } }
  try {
    const res = await fetch(`${cfg.url}/auth/v1${path}`, {
      method,
      headers: {
        apikey: cfg.key,
        Authorization: `Bearer ${token || cfg.key}`,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    let parsed = null
    try {
      parsed = text ? JSON.parse(text) : null
    } catch {
      parsed = null
    }
    return { status: res.status, body: parsed }
  } catch (err) {
    console.error('account: auth service unreachable —', err?.message || err)
    return { status: 0, body: { reason: 'unreachable' } }
  }
}

// GoTrue's error prose is written for developers. These are the sentences the
// page shows instead — specific where being specific helps the person, and
// deliberately vague where being specific would help somebody guessing.
function said(body) {
  const msg = String(body?.error_description || body?.msg || body?.message || '').toLowerCase()
  if (msg.includes('already registered')) return { reason: 'exists', message: 'That email already has an account — log in instead.' }
  if (msg.includes('not confirmed')) return { reason: 'unconfirmed', message: 'Your email isn’t confirmed yet — the link is in your inbox.' }
  if (msg.includes('invalid login credentials')) return { reason: 'bad-login', message: 'That email and password don’t match anything here.' }
  if (msg.includes('password should be')) return { reason: 'weak-password', message: 'Passwords need at least 10 characters.' }
  if (msg.includes('rate limit') || msg.includes('too many')) return { reason: 'slow-down', message: 'Too many tries in a row — give it a minute.' }
  return { reason: 'refused', message: 'That didn’t go through — check the details and try again.' }
}

// ------------------------------------------------------------- the doors

// Create an account. `kind` is 'customer' or 'brand' — the same door, worn
// two ways; a brand signup also carries the company name. Both land in the
// user's metadata, where the workspace can read them too.
export async function signUp({ email, password, name, kind, company }) {
  const { status, body } = await gotrue('/signup', {
    body: {
      email,
      password,
      data: {
        full_name: String(name || '').slice(0, 120),
        account_kind: kind === 'brand' ? 'brand' : 'customer',
        ...(kind === 'brand' && company ? { company: String(company).slice(0, 160) } : {}),
      },
    },
  })

  if (status === 0) return { ok: false, ...refusalFor(body) }
  if (status >= 400) return { ok: false, ...said(body) }

  // Two honest outcomes. With email confirmation on (which it should be —
  // the portal shows purchases matched by address, so the address has to be
  // proven), there is a user but no session yet: the next step is an inbox.
  if (body?.access_token && body?.refresh_token) {
    return { ok: true, state: 'in', session: sessionOf(body), user: presentUser(body.user) }
  }
  return { ok: true, state: 'confirm' }
}

export async function signIn({ email, password }) {
  const { status, body } = await gotrue('/token?grant_type=password', { body: { email, password } })
  if (status === 0) return { ok: false, ...refusalFor(body) }
  if (status >= 400) return { ok: false, ...said(body) }
  if (!body?.access_token || !body?.refresh_token) return { ok: false, reason: 'refused', message: 'That didn’t go through — try again.' }
  return { ok: true, state: 'in', session: sessionOf(body), user: presentUser(body.user) }
}

// The way back in for a forgotten password. GoTrue mails a recovery link;
// `redirect_to` brings it back to our own account page, which recognises the
// recovery fragment and offers the new-password form. The address must be on
// the Supabase project's redirect allow-list — the README says so.
export async function recover({ email, origin }) {
  const back = `${origin}/shop/account/`
  const { status, body } = await gotrue(`/recover?redirect_to=${encodeURIComponent(back)}`, { body: { email } })
  if (status === 0) return { ok: false, ...refusalFor(body) }
  // 422/429 aside, GoTrue answers 200 whether or not the address exists —
  // which is right: a password form must not double as a directory.
  if (status >= 400) return { ok: false, ...said(body) }
  return { ok: true }
}

// Set a new password, holding the recovery token the emailed link carried.
export async function resetPassword({ token, password }) {
  const { status, body } = await gotrue('/user', { method: 'PUT', token, body: { password } })
  if (status === 0) return { ok: false, ...refusalFor(body) }
  if (status >= 400) return { ok: false, ...said(body) }
  return { ok: true }
}

export async function signOut(token) {
  if (token) await gotrue('/logout', { token })
  return { ok: true }
}

function refusalFor(body) {
  return body?.reason === 'not-configured'
    ? { reason: 'not-configured', message: 'Accounts aren’t connected yet — nothing was saved.' }
    : { reason: 'unreachable', message: 'The account service didn’t answer — our side, not yours. Try again shortly.' }
}

// --------------------------------------------------------- who is asking
//
// The one call every portal endpoint starts with. Reads the cookie, asks
// GoTrue who the access token belongs to, and silently refreshes an expired
// hour behind the person's back. Hands back `setCookie` whenever the pair
// rolled, so the caller can send the new one down with its response.

export async function requireUser(req) {
  const held = readTokens(req)
  if (!held) return { ok: false, reason: 'signed-out' }

  let { status, body } = await gotrue('/user', { method: 'GET', token: held.access })

  let session = null
  if (status === 401 && held.refresh) {
    const renewed = await gotrue('/token?grant_type=refresh_token', { body: { refresh_token: held.refresh } })
    if (renewed.status === 200 && renewed.body?.access_token) {
      session = sessionOf(renewed.body)
      ;({ status, body } = await gotrue('/user', { method: 'GET', token: session.access }))
    }
  }

  if (status !== 200 || !body?.id) return { ok: false, reason: 'signed-out' }

  return {
    ok: true,
    user: presentUser(body),
    token: session ? session.access : held.access,
    setCookie: session || null,
  }
}

// The user, as the pages need to read them — and nothing else GoTrue holds.
function presentUser(u) {
  if (!u) return null
  const meta = u.user_metadata || {}
  return {
    id: u.id,
    email: u.email || '',
    // Purchases and invoices are matched by address, so the address has to
    // be proven before any of that is shown. Signed in and unconfirmed is a
    // real state; the portal says "confirm first" rather than guessing.
    confirmed: Boolean(u.email_confirmed_at || u.confirmed_at),
    name: String(meta.full_name || meta.name || '').slice(0, 120),
    kind: meta.account_kind === 'brand' ? 'brand' : 'customer',
    company: String(meta.company || '').slice(0, 160),
  }
}

function sessionOf(body) {
  return { access: body.access_token, refresh: body.refresh_token || '' }
}

// ------------------------------------------------------------- the cookie
//
// The pair, base64url over our own JSON shape. It is not signed by us — the
// access token inside is already signed by Supabase and verified there on
// every read, so a forged cookie buys exactly nothing.

export function readTokens(req) {
  const jar = req.headers.get('cookie') || ''
  const found = jar.split(';').map((c) => c.trim()).find((c) => c.startsWith(ACCOUNT_COOKIE + '='))
  if (!found) return null
  try {
    const raw = decodeURIComponent(found.slice(ACCOUNT_COOKIE.length + 1))
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
    if (!parsed || typeof parsed.a !== 'string' || !parsed.a) return null
    return { access: parsed.a, refresh: typeof parsed.r === 'string' ? parsed.r : '' }
  } catch {
    // A cookie is just a string somebody can put anything in. Unreadable is
    // signed out, never a 500.
    return null
  }
}

export function accountCookie(session, req) {
  const secure = !/^https?:\/\/(localhost|127\.0\.0\.1)/i.test(req.url) ? '; Secure' : ''
  const value = Buffer.from(JSON.stringify({ a: session.access, r: session.refresh }), 'utf8').toString('base64url')
  return `${ACCOUNT_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict${secure}; Max-Age=${COOKIE_MAX_AGE}`
}

export function clearAccountCookie(req) {
  const secure = !/^https?:\/\/(localhost|127\.0\.0\.1)/i.test(req.url) ? '; Secure' : ''
  return `${ACCOUNT_COOKIE}=; Path=/; HttpOnly; SameSite=Strict${secure}; Max-Age=0`
}

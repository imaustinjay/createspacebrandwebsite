// The door onto the analytics portal — and the only place in this repo that
// decides who is the owner.
//
// The stockroom (/api/products) is opened by a single bearer token typed into
// a page. That is fine for an upload endpoint nobody knows exists, but this
// portal holds the site's traffic, its search terms and its weak spots, and
// "one secret, typed anywhere, forever" is not the shape of a login. So this
// is a real one, in three parts:
//
//   1. a passphrase, held as a scrypt hash so the env var isn't the secret;
//   2. a six-digit code, sent to the owner's mailbox — possession, not just
//      knowledge, which is what makes it *verified*;
//   3. a signed, HttpOnly session cookie, so the browser carries proof
//      afterwards and no script on the page can read it.
//
// Everything is timing-safe, every failure is counted per-IP, and the whole
// door is shut — 503, not open — whenever it isn't fully configured. An
// analytics page that guesses at authorisation is worse than one that admits
// it has none.
import { createHmac, randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto'
import { clean } from './catalog.mjs'
import { mailbox, sendMail, table } from './mail.mjs'

export const SESSION_COOKIE = 'cs_portal'

// Twelve hours: long enough to look at the numbers across a working day,
// short enough that a forgotten laptop closes itself.
const SESSION_MS = 12 * 60 * 60 * 1000

// A mailed code is only worth something while it is fresh.
const CODE_MS = 10 * 60 * 1000
const CODE_ATTEMPTS = 5

// Failed passphrases, per IP. Ten in an hour is far past "I mistyped it".
const LOCK_WINDOW_MS = 60 * 60 * 1000
const LOCK_AFTER = 10

const memory = new Map()

// Blobs, with the same in-memory fallback the rest of the shop uses: a bad
// afternoon at Netlify should not lock the owner out of their own site. The
// fallback is per-instance and short-lived, which is exactly right for
// challenges and lockout counters and wrong for anything else.
async function store() {
  try {
    const { getStore } = await import('@netlify/blobs')
    return getStore({ name: 'admin-auth', consistency: 'strong' })
  } catch (err) {
    console.error('admin-session: blobs unavailable, using memory —', err?.message || err)
    return null
  }
}

async function read(key) {
  const s = await store()
  if (s) {
    try {
      return await s.get(key, { type: 'json' })
    } catch (err) {
      console.error('admin-session: read failed —', err?.message || err)
      return null
    }
  }
  const held = memory.get(key)
  return held && held.exp > Date.now() ? held.value : null
}

async function write(key, value) {
  const s = await store()
  if (s) {
    try {
      await s.setJSON(key, value)
      return
    } catch (err) {
      console.error('admin-session: write failed —', err?.message || err)
      return
    }
  }
  memory.set(key, { value, exp: Date.now() + CODE_MS * 2 })
}

async function drop(key) {
  const s = await store()
  if (s) {
    try {
      await s.delete(key)
      return
    } catch (err) {
      console.error('admin-session: delete failed —', err?.message || err)
      return
    }
  }
  memory.delete(key)
}

function equal(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8')
  const right = Buffer.from(String(b || ''), 'utf8')
  // timingSafeEqual throws on a length mismatch, and the lengths themselves
  // are not a secret worth protecting here — the contents are.
  if (left.length !== right.length || !left.length) return false
  return timingSafeEqual(left, right)
}

// ---------------------------------------------------------------- the config
//
// One place that answers "is this door usable, and how strong is it", so both
// the function and the page can say the same thing rather than each guessing.

export function ownerEmail() {
  const explicit = clean(process.env.ADMIN_EMAIL)
  if (explicit) return explicit
  const box = mailbox()
  return box ? box.to : ''
}

// The passphrase, as either a scrypt hash (preferred — the env var is then
// not the secret, only a verifier for it) or a plain value. Plain is
// supported because it is what somebody will reach for first, and refusing
// it would only push the whole thing into a worse place.
function passphrase() {
  const hash = clean(process.env.ADMIN_PASSWORD_HASH)
  if (hash && /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/i.test(hash)) return { kind: 'hash', value: hash }
  const plain = clean(process.env.ADMIN_PASSWORD)
  if (plain) return { kind: 'plain', value: plain }
  return null
}

// Hash a passphrase the way ADMIN_PASSWORD_HASH stores it. Exported so the
// portal can print a ready-to-paste line rather than sending the owner off to
// find a hashing tool they have to trust.
export function hashPassphrase(value, saltHex) {
  const salt = saltHex ? Buffer.from(saltHex, 'hex') : randomBytes(16)
  const derived = scryptSync(String(value), salt, 64)
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`
}

function passphraseMatches(offered) {
  const held = passphrase()
  if (!held) return false
  if (held.kind === 'plain') return equal(offered, held.value)
  const [, saltHex] = held.value.split('$')
  try {
    return equal(hashPassphrase(offered, saltHex).toLowerCase(), held.value.toLowerCase())
  } catch (err) {
    console.error('admin-session: ADMIN_PASSWORD_HASH is malformed —', err?.message || err)
    return false
  }
}

// What signs the session cookie. Set it explicitly to keep sessions alive
// across a passphrase change; leave it and it is derived, so changing the
// passphrase signs everyone out — which is the behaviour you want on the day
// you change it because something leaked.
function signingKey() {
  const explicit = clean(process.env.ADMIN_SESSION_SECRET)
  if (explicit && explicit.length >= 16) return explicit
  const held = passphrase()
  const seed = (held ? held.value : '') + clean(process.env.ADMIN_TOKEN)
  return seed.length >= 16 ? 'derived:' + seed : ''
}

// { ok } · { ok: false, reason } — the single answer to "can anyone log in".
export function doorState() {
  const held = passphrase()
  const key = signingKey()
  const email = ownerEmail()
  const box = mailbox()
  if (!held) return { ok: false, reason: 'no-passphrase' }
  if (held.kind === 'plain' && held.value.length < 12) return { ok: false, reason: 'weak-passphrase' }
  if (!key) return { ok: false, reason: 'no-session-secret' }
  return {
    ok: true,
    // Whether step two can actually happen. False is a working login with one
    // factor, and the page says so out loud rather than implying two.
    secondFactor: Boolean(box && email),
    // Masked, so the page can say where the code went without printing an
    // address to whoever is standing at a login screen.
    sentTo: box && email ? maskEmail(email) : null,
    storedAs: held.kind,
  }
}

export function maskEmail(address) {
  const [name, domain] = String(address || '').split('@')
  if (!name || !domain) return ''
  const head = name.slice(0, 2)
  return `${head}${'•'.repeat(Math.max(2, name.length - 2))}@${domain}`
}

// ------------------------------------------------------------- the lockout

export async function locked(ip) {
  const hits = (await read(`lock/${ip}`)) || []
  const now = Date.now()
  return hits.filter((t) => now - t < LOCK_WINDOW_MS).length >= LOCK_AFTER
}

export async function countFailure(ip) {
  const now = Date.now()
  const hits = ((await read(`lock/${ip}`)) || []).filter((t) => now - t < LOCK_WINDOW_MS)
  hits.push(now)
  await write(`lock/${ip}`, hits)
  return hits.length
}

export async function clearFailures(ip) {
  await drop(`lock/${ip}`)
}

// ------------------------------------------------------------ step one → two
//
// The passphrase is checked here, and a code is put in the owner's inbox. The
// challenge id comes back to the browser; the code never does.

export async function beginSignIn({ offered, ip, userAgent }) {
  if (!passphraseMatches(offered)) return { ok: false, reason: 'bad-passphrase' }

  const state = doorState()
  if (!state.ok) return { ok: false, reason: state.reason }

  // No mailbox, no second factor. Rather than pretend, hand back a session
  // now and let the page say plainly that it is one factor deep.
  if (!state.secondFactor) {
    return { ok: false, reason: 'no-mailbox', session: mintSession() }
  }

  const id = randomBytes(18).toString('hex')
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
  await write(`challenge/${id}`, {
    codeHash: createHmac('sha256', signingKey()).update(code).digest('hex'),
    exp: Date.now() + CODE_MS,
    attempts: 0,
    ip,
  })

  const when = new Date().toUTCString()
  const sent = await sendMail({
    to: ownerEmail(),
    subject: `${code} — your createspace portal code`,
    text: [
      `Your sign-in code is ${code}.`,
      '',
      'It opens the site analytics portal and expires in 10 minutes.',
      `Requested ${when} from ${ip}.`,
      '',
      "If this wasn't you, nobody is in — the code is the second half of the",
      'door and it is sitting here with you. Change ADMIN_PASSWORD anyway.',
    ].join('\n'),
    html: `${table(
      [
        ['Code', code],
        ['Expires', '10 minutes from now'],
        ['Requested', when],
        ['From', `${ip}${userAgent ? ` · ${userAgent.slice(0, 90)}` : ''}`],
      ],
      'Portal sign-in'
    )}
    <p style="font-family: Arial, sans-serif; font-size: 12px; color: rgba(78,49,44,0.55); max-width: 560px; padding: 0 28px 24px; margin: 0; background: #FFFFF0;">
      If this wasn't you, nobody is in — whoever typed the passphrase cannot finish without this code. Change <b>ADMIN_PASSWORD</b> regardless.
    </p>`,
  })

  if (!sent.ok) {
    await drop(`challenge/${id}`)
    return { ok: false, reason: sent.reason === 'not-configured' ? 'no-mailbox' : 'send-failed' }
  }

  console.log('portal: sign-in code sent', { ip, challenge: id.slice(0, 8) })
  return { ok: true, challenge: id, sentTo: state.sentTo, expiresIn: Math.round(CODE_MS / 1000) }
}

// -------------------------------------------------------------- step two
export async function finishSignIn({ challenge, code, ip }) {
  const key = `challenge/${String(challenge || '').replace(/[^a-f0-9]/gi, '')}`
  const held = await read(key)
  if (!held) return { ok: false, reason: 'expired' }
  if (held.exp < Date.now()) {
    await drop(key)
    return { ok: false, reason: 'expired' }
  }
  // The challenge belongs to the browser that asked for it. Without this, a
  // code read over someone's shoulder could be spent from anywhere.
  if (held.ip && held.ip !== ip) return { ok: false, reason: 'wrong-place' }

  const offered = createHmac('sha256', signingKey()).update(String(code || '').trim()).digest('hex')
  if (!equal(offered, held.codeHash)) {
    const attempts = (held.attempts || 0) + 1
    if (attempts >= CODE_ATTEMPTS) {
      await drop(key)
      return { ok: false, reason: 'burned' }
    }
    await write(key, { ...held, attempts })
    return { ok: false, reason: 'bad-code', left: CODE_ATTEMPTS - attempts }
  }

  // Spent, immediately — a code is good exactly once.
  await drop(key)
  return { ok: true, session: mintSession() }
}

// ------------------------------------------------------------ the session
//
// value.signature, where value is the JSON payload. No library, no JWT: this
// is read by exactly one server, so a plain HMAC over our own shape is both
// smaller and easier to be sure about.

function mintSession() {
  const payload = { iat: Date.now(), exp: Date.now() + SESSION_MS, jti: randomBytes(9).toString('hex') }
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const mac = createHmac('sha256', signingKey()).update(body).digest('base64url')
  return { token: `${body}.${mac}`, expiresAt: payload.exp }
}

export function readSession(req) {
  const key = signingKey()
  if (!key) return null
  const jar = req.headers.get('cookie') || ''
  const found = jar.split(';').map((c) => c.trim()).find((c) => c.startsWith(SESSION_COOKIE + '='))
  if (!found) return null

  const raw = decodeURIComponent(found.slice(SESSION_COOKIE.length + 1))
  const cut = raw.lastIndexOf('.')
  if (cut < 1) return null

  const body = raw.slice(0, cut)
  const mac = raw.slice(cut + 1)
  const expected = createHmac('sha256', key).update(body).digest('base64url')
  if (!equal(mac, expected)) return null

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    if (!payload || typeof payload.exp !== 'number' || payload.exp < Date.now()) return null
    return payload
  } catch {
    return null
  }
}

// HttpOnly so no script — ours, an extension's, or an injected one — can read
// it. SameSite=Strict so it is never attached to a request another site
// started. Secure everywhere but localhost, where there is no TLS to be
// secure over and the flag would silently drop the cookie.
export function sessionCookie({ token, expiresAt }, req) {
  const secure = !/^https?:\/\/(localhost|127\.0\.0\.1)/i.test(req.url) ? '; Secure' : ''
  const maxAge = Math.max(0, Math.round((expiresAt - Date.now()) / 1000))
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict${secure}; Max-Age=${maxAge}`
}

export function clearCookie(req) {
  const secure = !/^https?:\/\/(localhost|127\.0\.0\.1)/i.test(req.url) ? '; Secure' : ''
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict${secure}; Max-Age=0`
}

// The one line every protected endpoint starts with.
export function clientIp(req, context) {
  return (
    context?.ip ||
    req.headers.get('x-nf-client-connection-ip') ||
    (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() ||
    'unknown'
  )
}

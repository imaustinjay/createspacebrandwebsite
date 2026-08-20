// /api/admin-auth — the portal's login, and nothing else.
//
//   GET     is anyone signed in, and is the door even usable
//   POST    { step: 'passphrase', passphrase }   → mails a code
//   POST    { step: 'code', challenge, code }    → sets the session cookie
//   POST    { step: 'hash', passphrase }         → (signed in) a hash to paste
//   DELETE  sign out
//
// Kept apart from /api/insights on purpose: one function decides who you are,
// the other assumes it has already been decided. That split is what makes the
// second one short enough to read in one sitting.
import {
  beginSignIn,
  clearCookie,
  clearFailures,
  clientIp,
  countFailure,
  doorState,
  finishSignIn,
  hashPassphrase,
  locked,
  readSession,
  sessionCookie,
} from '../shared/admin-session.mjs'

const NO_STORE = { 'Cache-Control': 'no-store' }

// Why the door is shut, said the way the person who has to fix it needs to
// hear it — the variable's name, and what to set it to.
const SHUT = {
  'no-passphrase':
    'This portal is not set up yet. Set ADMIN_PASSWORD (16+ characters) in Netlify, redeploy, and come back.',
  'weak-passphrase':
    'ADMIN_PASSWORD is shorter than 12 characters. Lengthen it, redeploy, and come back — a short one here is the whole door.',
  'no-session-secret':
    'ADMIN_SESSION_SECRET is unset and could not be derived. Set it to 24+ random characters, redeploy, and come back.',
}

function json(body, init = {}) {
  return Response.json(body, { ...init, headers: { ...NO_STORE, ...(init.headers || {}) } })
}

export default async (req, context) => {
  const ip = clientIp(req, context)
  const door = doorState()

  // ------------------------------------------------------------- who am I
  if (req.method === 'GET') {
    const session = readSession(req)
    return json({
      ok: true,
      signedIn: Boolean(session),
      expiresAt: session ? session.exp : null,
      door: door.ok
        ? { ok: true, secondFactor: door.secondFactor, sentTo: door.sentTo, storedAs: door.storedAs }
        : { ok: false, reason: door.reason, message: SHUT[door.reason] || 'This portal is not set up yet.' },
    })
  }

  // ---------------------------------------------------------- sign out
  if (req.method === 'DELETE') {
    return json({ ok: true }, { headers: { 'Set-Cookie': clearCookie(req) } })
  }

  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 })

  if (!door.ok) {
    console.error('portal: sign-in attempted while the door is unconfigured —', door.reason)
    return json({ error: SHUT[door.reason] || 'This portal is not set up yet.', reason: door.reason }, { status: 503 })
  }

  let body = {}
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Bad request' }, { status: 400 })
  }

  const step = String(body.step || '')

  // ----------------------------------------------- upgrade to a stored hash
  // Only from inside. The point of ADMIN_PASSWORD_HASH is that the env var
  // stops being the secret; handing the hashing out to anyone who asks would
  // turn this into an oracle for testing guesses without the lockout.
  if (step === 'hash') {
    if (!readSession(req)) return json({ error: 'Not authorised.' }, { status: 401 })
    const value = String(body.passphrase || '')
    if (value.length < 16) {
      return json({ error: 'Use at least 16 characters — this is the half of the door you can be phished out of.' }, { status: 400 })
    }
    return json({ ok: true, hash: hashPassphrase(value) })
  }

  // Everything below is a guess at the passphrase or at a code, so it is
  // counted. The lockout is per-IP and deliberately blunt.
  if (await locked(ip)) {
    console.warn('portal: locked out', { ip })
    return json(
      { error: 'Too many attempts from here. Give it an hour.', reason: 'locked' },
      { status: 429 }
    )
  }

  // ------------------------------------------------------ step one: know it
  if (step === 'passphrase') {
    const result = await beginSignIn({
      offered: String(body.passphrase || ''),
      ip,
      userAgent: req.headers.get('user-agent') || '',
    })

    if (result.ok) {
      await clearFailures(ip)
      return json({ ok: true, challenge: result.challenge, sentTo: result.sentTo, expiresIn: result.expiresIn })
    }

    // No mailbox is not a wrong passphrase — the passphrase was right, and
    // there is simply no second factor to ask for. Let them in and say so,
    // rather than locking the owner out of their own site over an unset
    // SMTP variable.
    if (result.reason === 'no-mailbox' && result.session) {
      await clearFailures(ip)
      console.warn('portal: signed in on one factor — no mailbox configured')
      return json(
        {
          ok: true,
          signedIn: true,
          secondFactor: false,
          notice:
            'Signed in on the passphrase alone: no mailbox is configured, so no code could be sent. Set MAIL_USER and MAIL_PASSWORD to add the second step.',
          expiresAt: result.session.expiresAt,
        },
        { headers: { 'Set-Cookie': sessionCookie(result.session, req) } }
      )
    }

    if (result.reason === 'send-failed') {
      return json(
        { error: 'The passphrase was right, but the code could not be sent. Check MAIL_USER and MAIL_PASSWORD.', reason: 'send-failed' },
        { status: 502 }
      )
    }

    const count = await countFailure(ip)
    console.warn('portal: wrong passphrase', { ip, count })
    return json({ error: 'That is not the passphrase.', reason: 'bad-passphrase' }, { status: 401 })
  }

  // ------------------------------------------------------ step two: hold it
  if (step === 'code') {
    const result = await finishSignIn({ challenge: body.challenge, code: body.code, ip })
    if (result.ok) {
      await clearFailures(ip)
      console.log('portal: signed in', { ip })
      return json(
        { ok: true, signedIn: true, secondFactor: true, expiresAt: result.session.expiresAt },
        { headers: { 'Set-Cookie': sessionCookie(result.session, req) } }
      )
    }

    await countFailure(ip)
    const said = {
      expired: 'That code has expired. Start again and a fresh one will be sent.',
      burned: 'Too many wrong codes — that one is dead. Start again.',
      'wrong-place': 'That code was issued to a different browser. Start again here.',
      'bad-code': `That code is wrong.${typeof result.left === 'number' ? ` ${result.left} ${result.left === 1 ? 'try' : 'tries'} left.` : ''}`,
    }
    return json({ error: said[result.reason] || 'That code is wrong.', reason: result.reason }, { status: 401 })
  }

  return json({ error: 'Bad request' }, { status: 400 })
}

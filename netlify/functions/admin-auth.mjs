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

// ── When the mailbox refuses the sign-in code ────────────────────────────
//
// This branch used to say "check MAIL_USER and MAIL_PASSWORD", which is the
// one thing it cannot be: an unset pair signs you in on one factor at the
// branch above rather than shutting the door. So the person reading it was
// locked out of their own site and pointed at two variables that were
// demonstrably already set, with the real reason sitting in a function log
// they had no way to reach from the login screen.
//
// So the answer now carries the mail server's own words, names the account
// and host actually tried, and leads with the fix that matches what went
// wrong. Everything here is safe to show: a correct passphrase has already
// been proved, an SMTP reply never contains the credential, and the address
// is the house's own.
const HINT = {
  auth: 'Almost always the password: Titan, Google and Zoho all want an app-specific password here, not the one you type into the web mail. Generate one and set it as MAIL_PASSWORD.',
  recipient: 'The mail server took the login but refused the recipient. Check ADMIN_EMAIL — that is where the code is addressed, and it falls back to SHOP_EMAIL when unset.',
  reach: 'The mail server could not be reached at all. Check MAIL_SMTP_HOST and MAIL_SMTP_PORT — the default is smtp.titan.email on 465, which is the only port this sends on.',
  host: 'If the account is not on Titan, set MAIL_SMTP_HOST and MAIL_SMTP_PORT to your provider’s (the default is smtp.titan.email:465).',
  breakGlass:
    'To get in right now without fixing mail: add ADMIN_SECOND_FACTOR=off in Netlify and redeploy. The door then runs on the passphrase alone and says so on every sign-in. Remove it to bring the code back.',
}

/** Which of the three things went wrong, read from the mail server's reply.
    Order matters: the words a server uses are a better signal than its
    numbers, so plain-English recipient trouble is claimed before the 5.7.x
    codes, which are mostly — but not only — authentication. */
export function mailFault(detail = '') {
  const d = String(detail || '')
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ECONNRESET|ESOCKET|EDNS|greeting never received|timed? ?out/i.test(d)) return 'reach'
  if (/EENVELOPE|recipient|relay|mailbox (?:unavailable|not found)|no such user|user unknown|address rejected|does not exist/i.test(d)) return 'recipient'
  if (/EAUTH|invalid login|authenticat|credential|password|username|\b53[45]\b|5\.7\.[0-9]/i.test(d)) return 'auth'
  if (/\b5[05][0-9]\b/.test(d)) return 'recipient'
  return 'unknown'
}

/** The whole answer, pure, so the wording is a thing that can be tested. */
export function mailTrouble(result = {}) {
  const detail = String(result.detail || '')
  const fault = mailFault(detail)
  const fix =
    fault === 'auth' ? [HINT.auth, HINT.host]
    : fault === 'recipient' ? [HINT.recipient, HINT.auth]
    : fault === 'reach' ? [HINT.reach, HINT.auth]
    : [HINT.auth, HINT.host, HINT.recipient]
  return {
    error: 'The passphrase was right. The mailbox refused to send the code.',
    reason: 'send-failed',
    detail,
    mailbox: String(result.mailbox || ''),
    fix: [...fix, HINT.breakGlass],
  }
}

export default async (req, context) => {
  const ip = clientIp(req, context)
  const door = doorState()

  // ------------------------------------------------------------- who am I
  //
  // Readable without a session, because a login screen has to know whether
  // there is a login to attempt. It says as little as that requires.
  //
  // `sentTo` and `storedAs` are held back until there is a session. The
  // gate never displayed either — it reads only `ok` — so to a stranger they
  // were pure disclosure: the owner's mail domain, and whether the passphrase
  // is stored hashed. Neither is catastrophic and neither had a reason to be
  // there. The address is still shown after step one, where it belongs and
  // where the passphrase has already been proved.
  if (req.method === 'GET') {
    const session = readSession(req)
    return json({
      ok: true,
      signedIn: Boolean(session),
      expiresAt: session ? session.exp : null,
      door: door.ok
        ? {
            ok: true,
            // Kept public deliberately: it is the one field that answers "is
            // this thing configured properly" from a browser bar, and it
            // gives away nothing an attempted sign-in wouldn't.
            secondFactor: door.secondFactor,
            ...(session ? { sentTo: door.sentTo, storedAs: door.storedAs } : {}),
          }
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
    const value = String(body.passphrase || '').trim()
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
      // Trimmed, because a password manager pasting into the field routinely
      // brings a trailing space with it and a phone keyboard adds one after
      // autocomplete. Neither is something the owner typed, and a login that
      // fails on an invisible character is a login that fails at the worst
      // possible moment. The env var is trimmed by clean() at the other end,
      // so this only makes the two sides agree.
      offered: String(body.passphrase || '').trim(),
      ip,
      userAgent: req.headers.get('user-agent') || '',
    })

    if (result.ok) {
      // Deliberately NOT clearing the failure counter here.
      //
      // Getting the passphrase right is half of this door, and the half most
      // likely to have leaked — a leaked passphrase is the entire reason the
      // second step exists. Clearing the lockout on a correct passphrase
      // handed exactly that attacker a reset button: guess codes until the
      // counter climbs, re-post the passphrase, guess again, forever. The
      // counter is only cleared once both halves are proved, below.
      return json({ ok: true, challenge: result.challenge, sentTo: result.sentTo, expiresIn: result.expiresIn })
    }

    // The passphrase was right, but this address has asked for too many codes.
    // Said plainly, because the person who trips it is usually the owner
    // retrying — and because a vague message here sends them to the logs.
    if (result.reason === 'too-many-codes') {
      return json(
        {
          error: 'That is several codes in a short time. Use the most recent one, or wait an hour for a new one.',
          reason: 'too-many-codes',
        },
        { status: 429 }
      )
    }

    // No mailbox is not a wrong passphrase — the passphrase was right, and
    // there is simply no second factor to ask for. Let them in and say so,
    // rather than locking the owner out of their own site over an unset
    // SMTP variable.
    if (result.reason === 'no-mailbox' && result.session) {
      await clearFailures(ip)
      const deliberate = door.secondFactorDisabled
      console.warn('portal: signed in on one factor —', deliberate ? 'ADMIN_SECOND_FACTOR=off' : 'no mailbox configured')
      return json(
        {
          ok: true,
          signedIn: true,
          secondFactor: false,
          notice: deliberate
            ? 'Signed in on the passphrase alone — ADMIN_SECOND_FACTOR is off. Unset it to bring the mailed code back.'
            : 'Signed in on the passphrase alone: no mailbox is configured, so no code could be sent. Set MAIL_USER and MAIL_PASSWORD to add the second step.',
          expiresAt: result.session.expiresAt,
        },
        { headers: { 'Set-Cookie': sessionCookie(result.session, req) } }
      )
    }

    // The mailbox exists and REFUSED the send.
    if (result.reason === 'send-failed') {
      console.error('portal: sign-in code refused by the mailbox —', result.detail || 'no reason given', result.mailbox || '')
      return json(mailTrouble(result), { status: 502 })
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

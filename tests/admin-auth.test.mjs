// What the door says when the mailbox refuses the sign-in code.
//
// The bug this fixes was not in the crypto or the session — it was in a
// sentence. "The passphrase was right, but the code could not be sent. Check
// MAIL_USER and MAIL_PASSWORD." named the two variables that, had they been
// the problem, would have signed the owner in on one factor instead. So the
// message sent the only person who could fix it to look at the one place it
// could not be, while the SMTP reply that actually said "invalid login" went
// to a function log they could not reach from a login screen.
//
// A sentence can regress as quietly as it shipped, so it is tested.
//
// These live in tests/ rather than beside the function they cover, because
// `netlify.toml` sets `functions = "netlify/functions"` and Netlify deploys
// every top-level module in that directory as an endpoint — a file left there
// would be published at /.netlify/functions/<name>.test and run on request.
// The shared/ tests are colocated safely for exactly the same reason: that
// directory is deliberately outside the one Netlify scans.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mailFault, mailTrouble } from '../netlify/functions/admin-auth.mjs'

/* ── reading the mail server's reply ─────────────────────────────────────── */

test('an authentication refusal is read as one, in every dialect', () => {
  for (const reply of [
    'Invalid login: 535 5.7.8 Error: authentication failed',
    'Invalid login: 535 Incorrect authentication data',
    '534 5.7.9 Application-specific password required',
    'Missing credentials for "PLAIN"',
    'Username and Password not accepted',
  ]) {
    assert.equal(mailFault(reply), 'auth', reply)
  }
})

test('an unreachable server is not blamed on the password', () => {
  for (const reply of [
    'getaddrinfo ENOTFOUND smtp.titan.emial',
    'connect ECONNREFUSED 1.2.3.4:465',
    'Connection timeout',
    'Greeting never received',
    'connect ETIMEDOUT 1.2.3.4:465',
  ]) {
    assert.equal(mailFault(reply), 'reach', reply)
  }
})

test('a refused recipient points at the address, not the login', () => {
  for (const reply of [
    "Can't send mail - all recipients were rejected: 550 5.1.1 <nope@nowhere.invalid>: Recipient address rejected",
    '553 5.7.1 Relaying denied',
    'No recipients defined',
    '550 mailbox unavailable',
  ]) {
    assert.equal(mailFault(reply), 'recipient', reply)
  }
})

test('an unreadable reply is admitted as unreadable', () => {
  assert.equal(mailFault(''), 'unknown')
  assert.equal(mailFault(), 'unknown')
  assert.equal(mailFault('something went wrong'), 'unknown')
})

/* ── the answer that reaches the screen ──────────────────────────────────── */

test('the answer never blames the two variables it cannot be', () => {
  // The whole point. An unset MAIL_USER / MAIL_PASSWORD signs the owner in on
  // one factor — so if we are in this branch at all, those two are set, and
  // naming them is the most expensive wrong turn available.
  const answer = mailTrouble({ detail: 'Invalid login: 535 5.7.8 authentication failed', mailbox: 'desk@x.com → smtp.titan.email:465' })
  assert.doesNotMatch(answer.error, /MAIL_USER/)
  assert.doesNotMatch(answer.error, /check MAIL_/i)
  assert.equal(answer.reason, 'send-failed')
  assert.match(answer.error, /passphrase was right/i)
})

test('the mail server’s own words travel to the screen', () => {
  const answer = mailTrouble({ detail: 'Invalid login: 535 5.7.8', mailbox: 'desk@x.com → smtp.titan.email:465' })
  assert.equal(answer.detail, 'Invalid login: 535 5.7.8')
  assert.equal(answer.mailbox, 'desk@x.com → smtp.titan.email:465')
})

test('the likeliest fix leads, and matches what actually broke', () => {
  assert.match(mailTrouble({ detail: '535 authentication failed' }).fix[0], /app-specific password/i)
  assert.match(mailTrouble({ detail: 'connect ECONNREFUSED 1.2.3.4:465' }).fix[0], /MAIL_SMTP_HOST/)
  assert.match(mailTrouble({ detail: '550 recipient address rejected' }).fix[0], /ADMIN_EMAIL/)
  // Nothing readable in the reply — offer all three rather than guess.
  assert.equal(mailTrouble({ detail: 'nonsense' }).fix.length, 4)
})

test('the way back in is always offered, and is always last', () => {
  for (const detail of ['535 authentication failed', 'connect ECONNREFUSED', '550 rejected', 'nonsense', '']) {
    const fix = mailTrouble({ detail }).fix
    assert.match(fix[fix.length - 1], /ADMIN_SECOND_FACTOR=off/, detail)
    assert.equal(fix.filter((f) => /ADMIN_SECOND_FACTOR/.test(f)).length, 1, 'said once, at the end')
  }
})

test('a missing result is answered rather than thrown at', () => {
  const answer = mailTrouble()
  assert.equal(answer.detail, '')
  assert.equal(answer.mailbox, '')
  assert.ok(answer.fix.length >= 2)
})

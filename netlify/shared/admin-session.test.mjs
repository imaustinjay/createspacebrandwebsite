// The portal's door, and the one asymmetry that locked its owner out of it.
//
// A MISSING mailbox has always signed the owner in on the passphrase alone —
// the code refuses to lock somebody out of their own site over an unset SMTP
// variable, which is right. A BROKEN mailbox did not: a wrong password, a
// blocked login or a changed SMTP host returned "check MAIL_USER and
// MAIL_PASSWORD" and a shut door — naming the two variables that, had they
// been the problem, would have let them in.
//
// These hold both halves: the door reports its own strength honestly, and
// there is a deliberate, visible way past the second factor that does not
// require breaking the site's mail to get it.
import test from 'node:test'
import assert from 'node:assert/strict'
import { doorState, secondFactorOff, maskEmail } from './admin-session.mjs'

/** Run a block with a temporary environment, restored whatever happens. */
function withEnv(vars, fn) {
  const before = {}
  for (const k of Object.keys(vars)) before[k] = process.env[k]
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    return fn()
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

const WORKING = {
  ADMIN_PASSWORD: 'a-long-enough-passphrase-for-the-door',
  ADMIN_SESSION_SECRET: 'twenty-four-or-more-random-characters-here',
  MAIL_USER: 'desk@createspacebrand.com',
  MAIL_PASSWORD: 'an-app-password',
  SHOP_EMAIL: 'hello@createspacebrand.com',
  ADMIN_EMAIL: 'austin@createspacetalent.com',
  ADMIN_SECOND_FACTOR: undefined,
  ADMIN_PASSWORD_HASH: undefined,
  TITAN_EMAIL: undefined,
  TITAN_PASSWORD: undefined,
  PARTNERSHIPS_EMAIL: undefined,
}

/* ── the door reports its own strength ──────────────────────────────────── */

test('a fully configured door offers two factors and masks where the code goes', () => {
  withEnv(WORKING, () => {
    const d = doorState()
    assert.equal(d.ok, true)
    assert.equal(d.secondFactor, true)
    assert.equal(d.secondFactorDisabled, false)
    assert.match(d.sentTo, /@createspacetalent\.com$/)
    assert.doesNotMatch(d.sentTo, /^austin@/, 'the address is masked at a login screen')
  })
})

test('no mailbox is a working one-factor door, not a broken one', () => {
  withEnv({ ...WORKING, MAIL_USER: undefined, MAIL_PASSWORD: undefined }, () => {
    const d = doorState()
    assert.equal(d.ok, true, 'still usable — this is the anti-lockout rule')
    assert.equal(d.secondFactor, false)
    assert.equal(d.secondFactorDisabled, false, 'absent, not switched off — a different thing to say')
    assert.equal(d.sentTo, null)
  })
})

test('the second factor can be switched off deliberately, WITHOUT breaking the site’s mail', () => {
  // The workaround this replaces was "unset MAIL_USER and MAIL_PASSWORD",
  // which gets you in and takes every receipt, enquiry and invoice email on
  // the site down with it.
  withEnv({ ...WORKING, ADMIN_SECOND_FACTOR: 'off' }, () => {
    const d = doorState()
    assert.equal(d.ok, true)
    assert.equal(d.secondFactor, false, 'one factor, by choice')
    assert.equal(d.secondFactorDisabled, true, 'and the door says it was a choice')
    assert.equal(secondFactorOff(), true)
  })
})

test('switching it off is explicit — nothing else counts as off', () => {
  for (const value of ['', 'false', '0', 'no', 'disabled', 'OFF ']) {
    withEnv({ ...WORKING, ADMIN_SECOND_FACTOR: value }, () => {
      const expected = value.trim().toLowerCase() === 'off'
      assert.equal(secondFactorOff(), expected, `"${value}" → ${expected}`)
    })
  }
  withEnv({ ...WORKING, ADMIN_SECOND_FACTOR: 'off' }, () => assert.equal(secondFactorOff(), true))
  withEnv({ ...WORKING, ADMIN_SECOND_FACTOR: 'Off' }, () => assert.equal(secondFactorOff(), true))
})

test('turning it back on is unsetting it — no redeploy trap', () => {
  withEnv({ ...WORKING, ADMIN_SECOND_FACTOR: 'off' }, () => assert.equal(doorState().secondFactor, false))
  withEnv({ ...WORKING, ADMIN_SECOND_FACTOR: undefined }, () => assert.equal(doorState().secondFactor, true))
})

/* ── the door refuses to open when it would be weak ─────────────────────── */

test('a door with no passphrase, or a short one, is shut and says which', () => {
  withEnv({ ...WORKING, ADMIN_PASSWORD: undefined }, () => {
    assert.deepEqual(doorState(), { ok: false, reason: 'no-passphrase' })
  })
  withEnv({ ...WORKING, ADMIN_PASSWORD: 'short' }, () => {
    assert.deepEqual(doorState(), { ok: false, reason: 'weak-passphrase' })
  })
})

test('switching the second factor off does NOT open a door that was already shut', () => {
  // The opt-out is a way past step two, never a way past step one.
  withEnv({ ...WORKING, ADMIN_PASSWORD: 'short', ADMIN_SECOND_FACTOR: 'off' }, () => {
    assert.equal(doorState().ok, false)
    assert.equal(doorState().reason, 'weak-passphrase')
  })
  withEnv({ ...WORKING, ADMIN_PASSWORD: undefined, ADMIN_SECOND_FACTOR: 'off' }, () => {
    assert.equal(doorState().ok, false)
  })
})

/* ── the address, masked ────────────────────────────────────────────────── */

test('a masked address says the domain and hides the person', () => {
  assert.equal(maskEmail('austin@createspacetalent.com'), 'au••••@createspacetalent.com')
  assert.equal(maskEmail('ab@x.co'), 'ab••@x.co')
  assert.equal(maskEmail('not-an-address'), '')
  assert.equal(maskEmail(''), '')
  assert.equal(maskEmail(null), '')
})

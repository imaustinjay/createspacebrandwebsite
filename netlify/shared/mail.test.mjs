// The house mailer: which port means which kind of TLS, and when a mailbox
// counts as configured at all.
//
// The transport used to be built with `secure: true` and a port read from the
// environment — a pair that only agrees on 465. Set MAIL_SMTP_PORT to 587,
// which is the number Google, Zoho and half of Titan's own documentation put
// first, and every send on the site opens a TLS handshake against a server
// waiting to speak plain SMTP. It fails as a timeout that names neither the
// port nor the reason, and it takes the portal's own sign-in code with it.
import test from 'node:test'
import assert from 'node:assert/strict'
import { secureFor, mailbox } from './mail.mjs'

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

const BOX = {
  MAIL_USER: 'desk@example.com',
  MAIL_PASSWORD: 'an-app-password',
  SHOP_EMAIL: 'hello@example.com',
  MAIL_SMTP_HOST: undefined,
  MAIL_SMTP_PORT: undefined,
  PARTNERSHIPS_EMAIL: undefined,
  TITAN_EMAIL: undefined,
  TITAN_PASSWORD: undefined,
  TITAN_SMTP_HOST: undefined,
  TITAN_SMTP_PORT: undefined,
}

test('465 is TLS from the first byte; everything else starts in the clear', () => {
  assert.equal(secureFor(465), true)
  assert.equal(secureFor('465'), true, 'the port arrives from an env var as a string')
  assert.equal(secureFor(587), false, 'STARTTLS — the one that used to hang')
  assert.equal(secureFor(25), false)
  assert.equal(secureFor(2525), false)
})

test('a port nobody set still means 465', () => {
  withEnv(BOX, () => {
    const box = mailbox()
    assert.equal(box.port, 465)
    assert.equal(secureFor(box.port), true)
  })
})

test('setting 587 changes the TLS mode with it, rather than breaking every send', () => {
  withEnv({ ...BOX, MAIL_SMTP_PORT: '587' }, () => {
    const box = mailbox()
    assert.equal(box.port, 587)
    assert.equal(secureFor(box.port), false)
  })
})

test('an unset mailbox is null, not a half-built transport', () => {
  withEnv({ ...BOX, MAIL_PASSWORD: undefined }, () => assert.equal(mailbox(), null))
  withEnv({ ...BOX, MAIL_USER: undefined }, () => assert.equal(mailbox(), null))
})

test('the Titan names still work, because they are what is set in production', () => {
  withEnv({ ...BOX, MAIL_USER: undefined, MAIL_PASSWORD: undefined, TITAN_EMAIL: 'desk@x.com', TITAN_PASSWORD: 'p', TITAN_SMTP_PORT: '587' }, () => {
    const box = mailbox()
    assert.equal(box.user, 'desk@x.com')
    assert.equal(box.port, 587)
    assert.equal(secureFor(box.port), false)
  })
})

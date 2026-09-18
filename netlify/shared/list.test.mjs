// The list bridge: what crosses to the workspace, and the words the person agreed to.
import test from 'node:test'
import assert from 'node:assert/strict'
import { signupFrom, postSignup, CONSENT_TEXT } from './list.mjs'

test('the consent words are the workspace’s, byte for byte', () => {
  // shared/mailingListCore.mjs in createspace-workspace holds the same
  // string; its test asserts it too. Change one, change both.
  assert.equal(CONSENT_TEXT, 'Yes — write to me from createspace: a few emails a season, and I can leave the list any time.')
})

test('a signup carries consent only as a literal true', () => {
  const base = { reference: 'CS-FIT-1', email: ' Ada@Example.com ', name: 'Ada', handle: '@ada', tags: ['Assessment', 'assessment', 'x'] }
  assert.equal(signupFrom({ ...base, consent: true }).consent, true)
  for (const v of ['true', 1, 'on', undefined, null]) assert.equal(signupFrom({ ...base, consent: v }).consent, false)
  const s = signupFrom({ ...base, consent: true, assessment: { recommended: 'visual-brand-kit' } })
  assert.equal(s.email, 'ada@example.com')
  assert.deepEqual(s.tags, ['assessment', 'x'])
  assert.equal(s.consentText, CONSENT_TEXT)
  assert.equal(s.source, 'assessment')
  assert.equal(s.assessment.recommended, 'visual-brand-kit')
})

test('nothing without consent is ever posted — a verdict, not a retry', async () => {
  const out = await postSignup(signupFrom({ reference: 'CS-FIT-2', email: 'a@b.co', consent: false }))
  assert.equal(out.ok, false)
  assert.equal(out.retry, false)
})

test('without the bridge secret a signup is held, not dropped', async () => {
  const prev = process.env.SERVICE_BRIDGE_SECRET
  delete process.env.SERVICE_BRIDGE_SECRET
  try {
    const out = await postSignup(signupFrom({ reference: 'CS-FIT-3', email: 'a@b.co', consent: true }))
    assert.equal(out.ok, false)
    assert.equal(out.retry, true)
  } finally {
    if (prev !== undefined) process.env.SERVICE_BRIDGE_SECRET = prev
  }
})

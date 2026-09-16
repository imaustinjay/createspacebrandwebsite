// The service reference: minted once, read back on the invoice that continues
// the job it named.
//
// A job is often invoiced twice — a deposit and then a balance — and each one
// paid fires its own `invoice.paid`. The workspace holds the reference as a
// primary key, so pasting the first invoice's reference onto the second is
// what makes the second answer with the engagement already open instead of
// opening a duplicate. Which means the format has to round-trip exactly.
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { serviceReference, isServiceReference, SERVICE_REFERENCE_RE } from './services.mjs'

test('a minted reference is one this side recognises', () => {
  for (let i = 0; i < 200; i++) {
    const ref = serviceReference(randomBytes(6), 2026)
    assert.ok(isServiceReference(ref), ref)
  }
})

test('the alphabet has no character you could mishear down a phone line', () => {
  // A reference gets read aloud. 0/O and 1/I are the pairs that cost you.
  const tails = new Set()
  for (let i = 0; i < 400; i++) tails.add(serviceReference(randomBytes(6), 2026).slice(11))
  const all = [...tails].join('')
  for (const bad of ['0', 'O', '1', 'I']) assert.ok(!all.includes(bad), `${bad} must not appear`)
})

test('the year travels, because a reference outlives the year it was minted in', () => {
  assert.match(serviceReference(Buffer.from([0, 0, 0, 0, 0, 0]), 2026), /^CS-SVC-2026-/)
  assert.match(serviceReference(Buffer.from([0, 0, 0, 0, 0, 0]), 2031), /^CS-SVC-2031-/)
})

test('a reference that is not ours is refused rather than filed under a typo', () => {
  // Each of these opens a SECOND engagement for a job already under way if it
  // is let through, and nothing about the invoice looks wrong afterwards.
  for (const bad of [
    '',
    'CS-SVC-2026-K7M2P', // five characters
    'CS-SVC-2026-K7M2PQR', // seven
    'CS-SVC-26-K7M2PQ', // short year
    'CS-SVC-2026-K7M2P0', // a zero
    'CS-SVC-2026-K7M2PI', // an I
    'CS-2026-K7M2PQ', // the shop's own prefix, not a service
    'CS-SCOPE-2026-K7M2PQ',
    null,
    undefined,
  ]) {
    assert.equal(isServiceReference(bad), false, String(bad))
  }
})

test('the caller’s own normalising is the documented way in', () => {
  // billing.mjs trims and upper-cases before checking, so a pasted reference
  // with a stray space or a lowercase tail is accepted the way a person types
  // it. The helper does the same, so the two cannot disagree.
  assert.equal(isServiceReference('  cs-svc-2026-k7m2pq  '), true)
  assert.equal(SERVICE_REFERENCE_RE.test('cs-svc-2026-k7m2pq'), false, 'the raw regex is strict; the helper normalises')
})

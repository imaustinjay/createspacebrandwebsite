// The triage line (/triage/): the page is whole, every public page links to
// it, the proxies reach the workspace's three doors, and the quiet-line
// fallback lands with a person. Grep-the-source tripwires, like the rest.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const root = new URL('../', import.meta.url).pathname
const read = (p) => readFileSync(join(root, p), 'utf8')
const pages = (dir, out = []) => {
  for (const e of readdirSync(join(root, dir))) {
    const p = join(dir, e)
    if (statSync(join(root, p)).isDirectory()) pages(p, out)
    else if (e === 'index.html') out.push(p)
  }
  return out
}

test('the page carries its title, its stage, the honeypot, the hours and the three scripts it needs', () => {
  const html = read('public/triage/index.html')
  assert.match(html, /<title>The triage line — ask anything about building a creative career \| createspace<\/title>/)
  assert.match(html, /<link rel="canonical" href="https:\/\/createspacebrand\.com\/triage\/" \/>/)
  assert.match(html, /data-tl-ask/)
  assert.match(html, /data-tl-hp/, 'the honeypot the doors check')
  assert.match(html, /data-tl-answer/)
  assert.match(html, /data-tl-thread/)
  assert.match(html, /data-tl-topic-cards/)
  assert.match(html, /assets\/triage\.js\?v=\d+/)
  assert.match(html, /assets\/triage\.css\?v=\d+/)
  assert.match(html, /assets\/measure\.js/, 'counted like every public page')
  assert.match(html, /Nothing on the line is legal, tax or financial advice/)
  assert.match(html, /<noscript>/)
  assert.doesNotMatch(html, /!(?=[^<]*<\/(p|h1|h2|h3)>)/, 'no exclamation marks in the copy')
})

test('every public page links to the line from its nav and its footer', () => {
  const skip = new Set(['public/admin/index.html', 'public/shop/admin/index.html', 'public/triage/index.html'])
  for (const p of pages('public')) {
    if (skip.has(p)) continue
    const html = read(p)
    if (!/href="\/assessment\/">Find your fit</.test(html)) continue // a page without the house nav (a generated template)
    const n = (html.match(/href="\/triage\/">The triage line</g) || []).length
    assert.ok(n >= 1, `${p}: no link to the triage line`)
  }
  assert.match(read('public/sitemap.xml'), /<loc>https:\/\/createspacebrand\.com\/triage\/<\/loc>/)
})

test('the three doors are proxied to the workspace, forced, as status 200', () => {
  const toml = read('netlify.toml')
  for (const door of ['triage-bank', 'triage', 'triage-line']) {
    const re = new RegExp(`from = "/api/${door}"\\s+to = "https://createspacebrand\\.online/api/${door}"\\s+status = 200\\s+force = true`)
    assert.match(toml, re, `/api/${door}`)
  }
  assert.doesNotMatch(toml, /\/api\/triage-desk/, 'the desk is the team’s and never proxied through the public site')
})

test('the quiet-line fallback posts to the shop desk as kind triage, and the desk takes it', () => {
  const js = read('public/assets/triage.js')
  assert.match(js, /kind: 'triage'/)
  assert.match(js, /\/api\/triage-bank/)
  assert.match(js, /\/api\/triage-line/)
  assert.match(js, /localStorage\.setItem\(TOKEN_KEY/)
  assert.doesNotMatch(js, /createspacebrand\.online/, 'the page never names the workspace; the proxy does')
  const shop = read('netlify/functions/shop.mjs')
  assert.match(shop, /triage: \{\s*subject:/)
  assert.match(shop, /\['question', 'The question', 'required'\]/)
  assert.match(shop, /question: 2000/)
})

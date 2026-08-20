// What the site actually looks like to a crawler, read from the site itself.
//
// Every other panel in the portal reports something measured elsewhere —
// visits at the edge, impressions inside Google's index. This one is the site
// grading its own homework: it fetches its own pages over HTTP, exactly as
// Googlebot would receive them, and checks the handful of things that decide
// whether a page can rank at all.
//
// It is regex over HTML, not a parser, and that is a deliberate limit rather
// than a shortcut. The checks here are all shallow by nature — is there a
// title, is there one h1, does every image have alt text — and a parser would
// add a dependency to the bundle for questions a pattern answers. Anything
// that genuinely needs a DOM is not asked here, and is not implied to be.
//
// The result is cached for an hour in Blobs. A crawl is twenty-odd requests
// the site makes to itself, and nobody needs it recomputed because a page was
// refreshed.

const CACHE_MS = 60 * 60 * 1000
const PAGE_TIMEOUT_MS = 8000
const BATCH = 5

// The lengths Google actually renders before truncating, in characters. Not
// laws — a longer title is not a penalty — but a title cut off mid-word is a
// worse advert for the page than a shorter one that finishes its sentence.
const TITLE_MIN = 30
const TITLE_MAX = 62
const DESC_MIN = 70
const DESC_MAX = 165

async function cache() {
  try {
    const { getStore } = await import('@netlify/blobs')
    return getStore({ name: 'seo-audit', consistency: 'strong' })
  } catch {
    return null
  }
}

function tag(html, pattern) {
  const found = html.match(pattern)
  return found ? found[1].trim() : ''
}

function decode(value) {
  return String(value)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;|&rsquo;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&mdash;/g, '—')
    .replace(/&middot;/g, '·')
}

function meta(html, name) {
  const byName = html.match(
    new RegExp(`<meta[^>]+name=["']${name}["'][^>]+content=["']([^"']*)["']`, 'i')
  )
  if (byName) return decode(byName[1]).trim()
  const reversed = html.match(
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+name=["']${name}["']`, 'i')
  )
  return reversed ? decode(reversed[1]).trim() : ''
}

function property(html, prop) {
  const found = html.match(
    new RegExp(`<meta[^>]+property=["']${prop}["'][^>]+content=["']([^"']*)["']`, 'i')
  )
  return found ? decode(found[1]).trim() : ''
}

// The visible words, with everything that isn't prose taken out first. Used
// only as a thin-content signal: a page with sixty words on it cannot answer
// a search, whatever else is right about it.
function wordCount(html) {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
  return decode(text).split(/\s+/).filter((w) => /[a-z0-9]/i.test(w)).length
}

function headings(html, level) {
  const found = html.match(new RegExp(`<h${level}[^>]*>([\\s\\S]*?)</h${level}>`, 'gi')) || []
  return found.map((h) => decode(h.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()).filter(Boolean)
}

function images(html) {
  const found = html.match(/<img\b[^>]*>/gi) || []
  return found.map((img) => ({
    // An empty alt is a valid, deliberate statement — "this picture says
    // nothing a reader needs" — so it is not counted as missing. A missing
    // attribute is the fault.
    hasAlt: /\balt\s*=/i.test(img),
    alt: (img.match(/\balt=["']([^"']*)["']/i) || [, ''])[1],
    lazy: /loading=["']lazy["']/i.test(img),
    sized: /\bwidth\s*=/i.test(img) && /\bheight\s*=/i.test(img),
    src: (img.match(/\bsrc=["']([^"']+)["']/i) || [, ''])[1],
  }))
}

function structuredData(html) {
  const blocks = html.match(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi) || []
  const types = []
  let broken = 0
  for (const block of blocks) {
    const body = block.replace(/^[\s\S]*?>/, '').replace(/<\/script>$/i, '')
    try {
      const parsed = JSON.parse(body)
      const walk = (node) => {
        if (!node || typeof node !== 'object') return
        if (Array.isArray(node)) return node.forEach(walk)
        if (node['@type']) {
          for (const t of [].concat(node['@type'])) if (!types.includes(t)) types.push(t)
        }
        if (node['@graph']) walk(node['@graph'])
      }
      walk(parsed)
    } catch {
      // A schema block that doesn't parse is worse than none: Google reads
      // it, fails, and the page loses the rich result it was reaching for
      // without anything visibly breaking.
      broken += 1
    }
  }
  return { blocks: blocks.length, types, broken }
}

// One page, graded. `issues` is the whole point — each carries what is wrong,
// why it costs something, and the fix, so the portal never has to explain a
// finding it was only handed a label for.
function gradePage(path, html, status, origin) {
  const issues = []
  const title = decode(tag(html, /<title[^>]*>([\s\S]*?)<\/title>/i)).replace(/\s+/g, ' ').trim()
  const description = meta(html, 'description')
  const canonical = tag(html, /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i)
  const robots = meta(html, 'robots')
  const noindex = /noindex/i.test(robots)
  const h1s = headings(html, 1)
  const h2s = headings(html, 2)
  const h3s = headings(html, 3)
  const imgs = images(html)
  const schema = structuredData(html)
  const words = wordCount(html)
  const lang = tag(html, /<html[^>]+lang=["']([^"']+)["']/i)
  const viewport = meta(html, 'viewport')
  const ogTitle = property(html, 'og:title')
  const ogImage = property(html, 'og:image')
  const links = (html.match(/<a\b[^>]+href=["']\/[^"']*["']/gi) || []).length

  const add = (severity, what, why, fix) => issues.push({ severity, what, why, fix })

  if (status !== 200) {
    add('critical', `Returns ${status}`, 'A page that does not answer 200 cannot rank, and a link to it wastes the crawl budget spent reaching it.', 'Fix the route or remove it from sitemap.xml.')
  }

  // Everything below only matters for a page meant to be found. On a noindex
  // page — the checkout, the stockroom, this portal — a missing description
  // is correct, and flagging it would train the reader to ignore the list.
  if (noindex) {
    return {
      path, status, noindex: true, title, description, canonical, words,
      h1: h1s.length, h2: h2s.length, h3: h3s.length,
      images: imgs.length, imagesWithoutAlt: 0, schemaTypes: schema.types, internalLinks: links,
      score: null, issues: [],
    }
  }

  if (!title) add('critical', 'No title', 'The title is the headline of the search result and the strongest single ranking signal on the page. Without one Google writes its own from the body text.', 'Add a <title> of 30 to 60 characters, leading with the term this page should win.')
  else if (title.length < TITLE_MIN) add('warning', `Title is ${title.length} characters`, 'A short title leaves room on the result page unused, and usually means the page is not naming the search it wants.', `Take it to ${TITLE_MIN}-${TITLE_MAX} characters: the term first, the brand last.`)
  else if (title.length > TITLE_MAX) add('warning', `Title is ${title.length} characters`, `Google truncates around ${TITLE_MAX}, so the end of this one is invisible in the result.`, `Trim to ${TITLE_MAX} and make sure nothing load-bearing sits after character ${TITLE_MAX}.`)

  if (!description) add('critical', 'No meta description', 'Google writes its own snippet from whatever text it finds, which is rarely the sentence that would earn the click.', `Add a description of ${DESC_MIN}-${DESC_MAX} characters that says what the page gives and who it is for.`)
  else if (description.length < DESC_MIN) add('note', `Description is ${description.length} characters`, 'A short snippet takes less of the result page and makes a weaker case than the one below it.', `Take it to ${DESC_MIN}-${DESC_MAX} characters.`)
  else if (description.length > DESC_MAX) add('note', `Description is ${description.length} characters`, `Cut off around ${DESC_MAX}, so the closing line never appears.`, `Trim to ${DESC_MAX} and put the reason to click in the first sentence.`)

  if (!canonical) add('warning', 'No canonical URL', 'Without one, a page reachable at more than one address competes with itself and splits its own ranking.', `Add <link rel="canonical" href="${origin}${path}" />.`)

  if (h1s.length === 0) add('critical', 'No h1', 'The h1 tells a crawler what the page is about in the page\'s own words. Nothing else on the page does that job.', 'Give the page exactly one h1 that carries its main term.')
  else if (h1s.length > 1) add('warning', `${h1s.length} h1 headings`, 'More than one first-level heading leaves the topic ambiguous, and the extras dilute the one that matters.', 'Keep one h1; demote the rest to h2.')

  if (h2s.length === 0 && words > 300) add('note', 'No h2 headings', 'Long text with no subheadings is hard to scan and gives Google nothing to lift into a jump-to link or a featured snippet.', 'Break the page into sections with h2s that read like the questions people ask.')

  if (words < 150) add('warning', `Only ${words} words`, 'There is not enough text here to answer any search in depth, so the page will lose to one that does.', 'Take the page past 300 words of writing that answers the question it is titled after.')

  const noAlt = imgs.filter((i) => !i.hasAlt).length
  if (noAlt) add('warning', `${noAlt} image${noAlt === 1 ? '' : 's'} without alt text`, 'Alt text is what a screen reader announces and what image search indexes. Missing, the picture is invisible to both.', 'Describe what the image shows. If it is decoration, alt="" says so deliberately.')

  const unsized = imgs.filter((i) => !i.sized).length
  if (unsized > 2) add('note', `${unsized} images without width and height`, 'Unsized images make the page jump as they load, which is what Cumulative Layout Shift measures and Google reports as a Core Web Vital.', 'Add width and height attributes so the space is reserved before the image arrives.')

  const eager = imgs.slice(3).filter((i) => !i.lazy).length
  if (eager > 2) add('note', `${eager} below-fold images load eagerly`, 'Every one competes for bandwidth with the text somebody is waiting to read.', 'Add loading="lazy" to images below the first screen.')

  if (schema.broken) add('critical', `${schema.broken} structured-data block${schema.broken === 1 ? '' : 's'} will not parse`, 'Google reads the block, fails, and drops the rich result — with nothing visibly broken on the page to tell you.', 'Run the block through the Rich Results Test and fix the JSON.')
  else if (!schema.blocks) add('warning', 'No structured data', 'Structured data is how a page earns a rich result — a rating, a price, a set of FAQ lines under the link — instead of two plain lines.', 'Add JSON-LD naming what this page is: Organization, Service, Product, FAQPage or BreadcrumbList.')

  if (!ogTitle || !ogImage) add('note', 'Incomplete share card', 'A link shared without og:title and og:image renders as a bare URL, which almost nobody clicks.', 'Add og:title, og:description and og:image (1200x630).')

  if (!lang) add('warning', 'No lang on <html>', 'Screen readers guess the pronunciation and search engines guess the market.', 'Add lang="en".')
  if (!viewport) add('critical', 'No viewport meta', 'The page renders at desktop width on a phone. Google indexes the mobile version first, so this is the version that counts.', 'Add the standard viewport meta tag.')

  if (links < 3) add('warning', `Only ${links} internal link${links === 1 ? '' : 's'}`, 'Internal links are how ranking strength moves between pages and how a crawler finds the rest of the site. A page with almost none is a dead end.', 'Link out to the three or four pages a reader of this one would want next.')

  // A page starts at 100 and pays for what is wrong with it. The weights are
  // ordered the way the problems actually cost traffic, not the way they are
  // usually listed.
  const cost = { critical: 18, warning: 8, note: 3 }
  const score = Math.max(0, 100 - issues.reduce((sum, i) => sum + cost[i.severity], 0))

  return {
    path, status, noindex: false,
    title, titleLength: title.length,
    description, descriptionLength: description.length,
    canonical, words,
    h1: h1s.length, h1Text: h1s[0] || '', h2: h2s.length, h3: h3s.length,
    images: imgs.length, imagesWithoutAlt: noAlt,
    schemaTypes: schema.types, internalLinks: links,
    score, issues,
  }
}

// The pages to look at: whatever sitemap.xml says, because that is the list
// the site has told Google to care about. If a page is missing from there it
// is a finding in itself, so the sitemap is the right source rather than a
// hand-kept array that would quietly drift out of date.
async function sitemapPaths(origin) {
  try {
    const res = await fetch(`${origin}/sitemap.xml`, { headers: { 'User-Agent': 'createspace-portal/1.0' } })
    if (!res.ok) return { paths: [], error: `sitemap.xml returned ${res.status}` }
    const xml = await res.text()
    const found = xml.match(/<loc>([^<]+)<\/loc>/gi) || []
    const paths = found
      .map((loc) => loc.replace(/<\/?loc>/gi, '').trim())
      .map((url) => {
        try {
          return new URL(url).pathname
        } catch {
          return ''
        }
      })
      .filter(Boolean)
    return { paths: [...new Set(paths)], error: null }
  } catch (err) {
    return { paths: [], error: err?.message || 'sitemap.xml could not be read' }
  }
}

async function fetchPage(origin, path) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PAGE_TIMEOUT_MS)
  try {
    const res = await fetch(origin + path, {
      signal: controller.signal,
      headers: { 'User-Agent': 'createspace-portal/1.0 (site self-audit)' },
    })
    const html = res.ok ? await res.text() : ''
    return { status: res.status, html }
  } catch (err) {
    return { status: 0, html: '', error: err?.name === 'AbortError' ? 'timed out' : err?.message || 'unreachable' }
  } finally {
    clearTimeout(timer)
  }
}

export async function auditSite(origin, { force = false } = {}) {
  const store = await cache()
  if (store && !force) {
    try {
      const held = await store.get('latest', { type: 'json' })
      if (held && Date.now() - held.at < CACHE_MS) return { ...held, cached: true }
    } catch {
      /* a cold cache is not an error */
    }
  }

  const { paths, error } = await sitemapPaths(origin)
  if (!paths.length) {
    return { at: Date.now(), origin, error: error || 'sitemap.xml lists no pages', pages: [], cached: false }
  }

  const pages = []
  for (let i = 0; i < paths.length; i += BATCH) {
    const slice = paths.slice(i, i + BATCH)
    const fetched = await Promise.all(slice.map((p) => fetchPage(origin, p)))
    slice.forEach((path, n) => {
      const { status, html, error: pageError } = fetched[n]
      if (!html) {
        pages.push({
          path, status, noindex: false, score: 0,
          title: '', description: '', canonical: '', words: 0,
          h1: 0, h2: 0, h3: 0, images: 0, imagesWithoutAlt: 0, schemaTypes: [], internalLinks: 0,
          issues: [
            {
              severity: 'critical',
              what: pageError ? `Could not be fetched (${pageError})` : `Returns ${status}`,
              why: 'A page the sitemap points at and the server will not serve is a broken promise to every crawler that follows it.',
              fix: 'Fix the route, or take the URL out of sitemap.xml.',
            },
          ],
        })
        return
      }
      pages.push(gradePage(path, html, status, origin))
    })
  }

  // Duplicates across pages, which no single-page check can see. Two pages
  // sharing a title are two pages asking Google to rank them for the same
  // thing, and Google picks one — usually not the one you wanted.
  const titles = new Map()
  const descriptions = new Map()
  for (const page of pages) {
    if (page.noindex || !page.title) continue
    titles.set(page.title, [...(titles.get(page.title) || []), page.path])
    if (page.description) descriptions.set(page.description, [...(descriptions.get(page.description) || []), page.path])
  }
  const duplicateTitles = [...titles.entries()].filter(([, where]) => where.length > 1).map(([text, where]) => ({ text, where }))
  const duplicateDescriptions = [...descriptions.entries()].filter(([, where]) => where.length > 1).map(([text, where]) => ({ text, where }))

  const indexable = pages.filter((p) => !p.noindex)
  const scored = indexable.filter((p) => typeof p.score === 'number')
  const result = {
    at: Date.now(),
    origin,
    error: null,
    pages: pages.sort((a, b) => (a.score ?? 101) - (b.score ?? 101)),
    duplicateTitles,
    duplicateDescriptions,
    summary: {
      crawled: pages.length,
      indexable: indexable.length,
      score: scored.length ? Math.round(scored.reduce((s, p) => s + p.score, 0) / scored.length) : 0,
      critical: indexable.reduce((s, p) => s + p.issues.filter((i) => i.severity === 'critical').length, 0),
      warnings: indexable.reduce((s, p) => s + p.issues.filter((i) => i.severity === 'warning').length, 0),
      notes: indexable.reduce((s, p) => s + p.issues.filter((i) => i.severity === 'note').length, 0),
      clean: scored.filter((p) => !p.issues.length).length,
    },
    cached: false,
  }

  if (store) {
    try {
      await store.setJSON('latest', result)
    } catch (err) {
      console.error('seo-audit: could not cache the crawl —', err?.message || err)
    }
  }
  return result
}

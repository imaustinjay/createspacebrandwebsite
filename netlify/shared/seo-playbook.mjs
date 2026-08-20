// The suggestions half of the portal: what to do next, and why that and not
// something else.
//
// Two kinds of advice live here and they are kept visibly apart, because a
// reader has to know which is which.
//
//   Findings   — computed. Every one of these points at a page, a count, or a
//                measurement, and disappears from the list when it is fixed.
//                If it says twelve pages have no structured data, twelve
//                pages have no structured data.
//
//   Strategy   — written. The keyword map and the structural moves are
//                editorial judgement about this specific business, not
//                measurements of it. They are labelled that way and they do
//                not carry numbers they haven't earned.
//
// Nothing in here invents a search volume, a difficulty score or a ranking.
// Those come from Search Console or they are absent, and absent says so.

// ---------------------------------------------------------------- the map
//
// The terms this site should be trying to own, grouped by the job the
// searcher is doing rather than by topic — because the job is what decides
// which page should answer and what that page has to say.
//
// Every cluster names the page that should win it. Where no page exists yet,
// that is the recommendation.

export const KEYWORD_MAP = [
  {
    cluster: 'Who we are',
    intent: 'navigational',
    page: '/',
    why: 'Somebody who already heard the name. These convert best and cost nothing to win — the only way to lose them is to be outranked on your own name by a directory or a social profile.',
    terms: [
      'createspace brand',
      'createspace community and talent',
      'createspace creator community',
      'createspace brand reviews',
      'is createspace legit',
    ],
    move: 'Own every variant on one page. Organization schema with sameAs links to every social profile is what tells Google those profiles and this site are the same entity, so the knowledge panel points here.',
  },
  {
    cluster: 'Creator management',
    intent: 'commercial · high value',
    page: '/',
    why: 'The category term. Highest intent of anything on this list — somebody typing it is choosing a company — and therefore the hardest, because every agency with a budget is on it.',
    terms: [
      'creator management company',
      'creator management agency',
      'content creator management company',
      'creator management services',
      'what does a creator management company do',
      'creator management vs talent agency',
    ],
    move: 'The head term is a long fight. The two explainer phrasings at the bottom are winnable inside a quarter and pull the same audience one step earlier, which is where a small site should enter a competitive category.',
  },
  {
    cluster: 'Talent representation',
    intent: 'commercial · creator side',
    page: '/talent/',
    why: 'A creator looking to be signed. This is the roster pipeline, and the searches are unusually specific — which is exactly what a site this size can win.',
    terms: [
      'influencer talent agency',
      'talent representation for content creators',
      'how to get signed by a creator agency',
      'creator agency accepting new talent',
      'do I need a talent manager as a creator',
      'influencer management for small creators',
    ],
    move: 'Answer the qualifying questions on the page itself — who you take, what you take, what it costs, what happens after. Those are the searches, and a page that answers them earns the FAQ rich result as a side effect.',
  },
  {
    cluster: 'For brands',
    intent: 'commercial · buyer side',
    page: '/brands/',
    why: 'The side of the business with a budget attached. Fewer searches than the creator side and worth far more each.',
    terms: [
      'hire UGC creators',
      'book creators for brand campaigns',
      'influencer marketing agency for brands',
      'find content creators for my brand',
      'UGC creator agency',
      'managed influencer partnerships',
    ],
    move: 'Buyers search for proof, not promises. Named campaign outcomes, a rate range and a stated turnaround do more for this cluster than any amount of keyword placement.',
  },
  {
    cluster: 'Community, no follower requirement',
    intent: 'informational · the differentiator',
    page: '/creators/',
    why: 'The single most distinctive thing this brand says, and almost nobody else is saying it. Low competition, exactly matched audience — the best-value cluster on the list.',
    terms: [
      'creator community no follower requirement',
      'community for small content creators',
      'creator community for beginners',
      'where to find other creators to collaborate with',
      'creator community with no follower count',
      'how to start creating with no audience',
    ],
    move: 'Lead the page with the phrase itself. "No follower requirement" is the search and it should be visible in the title, the h1 and the first sentence — not implied three paragraphs down.',
  },
  {
    cluster: 'The Collection Program',
    intent: 'commercial · the paid cohort',
    page: '/collection/',
    why: 'A named program is its own entity search once anyone has heard of it. It also competes in the cohort/accelerator category, where being specific about outcomes beats being big.',
    terms: [
      'creator cohort program',
      'content creator accelerator program',
      'creator mentorship program',
      'paid creator community program',
      'creator program application',
    ],
    move: 'Give the program an Event or Course schema with its dates. Dated programs get rich results that plain pages cannot, and the date is what makes somebody act now.',
  },
  {
    cluster: 'The shop',
    intent: 'transactional',
    page: '/shop/products/',
    why: 'The only pages on this site that can carry a price into the search result. Product schema turns two grey lines into a price, a rating and availability.',
    terms: [
      'content planner for creators',
      'digital planner for content creators',
      'creator content system template',
      'social media content calendar template',
      'ugc creator starter kit',
      'aesthetic content kit',
    ],
    move: 'Product schema with offers on each product page, and one buyer question answered per product in prose the page did not have before. Templates rank on specificity — what it contains, what it does not.',
  },
  {
    cluster: 'Getting started',
    intent: 'informational · top of funnel',
    page: null,
    why: 'The largest search volume on the list by an order of magnitude, and the one this site currently has nowhere to put. Nobody buys management on this search — they meet the brand here and come back later.',
    terms: [
      'how to become a content creator',
      'how to start UGC with no experience',
      'how to make a media kit',
      'what to charge as a UGC creator',
      'how to pitch brands as a creator',
      'content creator contract template',
    ],
    move: 'This is the missing structural piece: there is no place on the site to answer a question. A journal at /journal/ with one honest answer per page is what turns this cluster from a list into traffic.',
  },
  {
    cluster: 'Working here',
    intent: 'navigational · recruiting',
    page: '/careers/',
    why: 'Small, but it is the cluster where an unanswered search costs you a person rather than a click.',
    terms: [
      'creator agency internships',
      'talent management internship remote',
      'influencer marketing jobs entry level',
      'creator economy internships',
    ],
    move: 'JobPosting schema when a role is genuinely open, and nothing when one is not. An expired posting in Google is worse than no posting.',
  },
]

// --------------------------------------------------------------- findings
//
// Turned from the crawl into a job list. Aggregated across pages on purpose:
// "eleven pages are missing a description" is one afternoon's work, while the
// same thing said eleven times is a wall nobody starts on.

function group(pages, match) {
  return pages.filter((p) => !p.noindex && p.issues.some(match)).map((p) => p.path)
}

function fromAudit(audit) {
  if (!audit || audit.error || !audit.pages?.length) return []
  const pages = audit.pages
  const found = []

  const push = (item) => {
    if (item.where.length) found.push(item)
  }

  push({
    id: 'titles-long',
    title: 'Titles are being cut off in the search result',
    impact: 'high',
    effort: 'an hour',
    why: 'Google renders roughly 60 characters of a title. Past that the reader sees an ellipsis, and the words you put last — usually the ones that would earn the click — are the ones nobody reads.',
    do: [
      'Rewrite each to 50-60 characters.',
      'Put the term the page should win in the first 30 characters.',
      'Keep the brand at the end, or drop it where the page is not about the brand.',
    ],
    where: group(pages, (i) => /^Title is \d+ characters$/.test(i.what) && Number(i.what.match(/\d+/)[0]) > 62),
  })

  push({
    id: 'descriptions-long',
    title: 'Meta descriptions run past the snippet',
    impact: 'medium',
    effort: 'an hour',
    why: 'Anything past about 165 characters is never shown. A description that makes its case in sentence three is making it nowhere.',
    do: [
      'Cut each to 140-160 characters.',
      'Open with what the reader gets, not with who you are.',
      'Make every page\'s description different — a shared one tells Google the pages are the same.',
    ],
    where: group(pages, (i) => /^Description is \d+ characters$/.test(i.what) && Number(i.what.match(/\d+/)[0]) > 165),
  })

  push({
    id: 'descriptions-missing',
    title: 'Pages with no meta description at all',
    impact: 'high',
    effort: 'an hour',
    why: 'Google writes its own snippet from whatever text it can find on the page. It is never the sentence you would have chosen, and it is often a nav label.',
    do: ['Write one per page, 140-160 characters, naming the page\'s search term once and plainly.'],
    where: group(pages, (i) => i.what === 'No meta description'),
  })

  push({
    id: 'schema-missing',
    title: 'Pages carrying no structured data',
    impact: 'high',
    effort: 'a day',
    why: 'Structured data is the difference between two grey lines and a result with a price, a rating, a date or a set of expandable questions under it. It is the largest change to how a listing looks that does not require moving up a single position.',
    do: [
      'Product + Offer on every /shop/products/ page — this is the one that shows a price in the result.',
      'FAQPage on /shop/faq/ and on any page with a real question-and-answer section.',
      'Service on /talent/ and /brands/.',
      'BreadcrumbList site-wide, so the result shows the path instead of a raw URL.',
      'Validate each in Google\'s Rich Results Test before shipping.',
    ],
    where: group(pages, (i) => i.what === 'No structured data'),
  })

  push({
    id: 'schema-broken',
    title: 'Structured data that will not parse',
    impact: 'high',
    effort: 'minutes',
    why: 'Google reads the block, fails on it, and silently drops the rich result. Nothing on the page looks broken, which is why this can sit unnoticed for months.',
    do: ['Paste each block into the Rich Results Test and fix the JSON it rejects.'],
    where: group(pages, (i) => /structured-data block/.test(i.what)),
  })

  push({
    id: 'h1',
    title: 'Heading structure needs settling',
    impact: 'medium',
    effort: 'an hour',
    why: 'The h1 is the page describing itself in its own words. None leaves the topic to be guessed; several leave it ambiguous, and the extras dilute the one that counts.',
    do: ['Give every indexable page exactly one h1 carrying its main term.', 'Demote the rest to h2.'],
    where: group(pages, (i) => i.what === 'No h1' || /h1 headings$/.test(i.what)),
  })

  push({
    id: 'h2',
    title: 'Long pages with no subheadings',
    impact: 'medium',
    effort: 'an hour',
    why: 'Subheadings are what Google lifts into a featured snippet and into the jump-to links under a result. A wall of text offers it nothing to lift.',
    do: [
      'Break each page into sections under h2s.',
      'Phrase the h2 as the question a reader would have asked — that phrasing is what wins the snippet.',
    ],
    where: group(pages, (i) => i.what === 'No h2 headings'),
  })

  push({
    id: 'thin',
    title: 'Pages too thin to answer a search',
    impact: 'medium',
    effort: 'a day',
    why: 'Under about 300 words there is not enough on the page to be the best answer to anything, so it loses to a page that goes further — regardless of how good the design is.',
    do: ['Take each past 300 words of writing that answers the question the title promises.'],
    where: group(pages, (i) => /^Only \d+ words$/.test(i.what)),
  })

  push({
    id: 'alt',
    title: 'Images without alt text',
    impact: 'medium',
    effort: 'an hour',
    why: 'Alt text is what a screen reader announces and what image search indexes. Missing it, the picture is invisible to both — and for a product page, image search is a real doorway.',
    do: [
      'Describe what the image shows, in a sentence a person would say.',
      'Use alt="" deliberately for pure decoration, so the omission reads as a decision.',
    ],
    where: group(pages, (i) => /images? without alt text$/.test(i.what)),
  })

  push({
    id: 'cls',
    title: 'Images without width and height',
    impact: 'medium',
    effort: 'an hour',
    why: 'The page jumps as each image arrives. That jump is Cumulative Layout Shift, it is one of the three Core Web Vitals Google reports, and it is the one that most annoys a reader on a phone.',
    do: ['Add width and height attributes so the space is reserved before the image loads.'],
    where: group(pages, (i) => /without width and height$/.test(i.what)),
  })

  push({
    id: 'lazy',
    title: 'Below-fold images loading eagerly',
    impact: 'low',
    effort: 'minutes',
    why: 'Each one competes for bandwidth with the text somebody is waiting to read, which shows up as a slower Largest Contentful Paint.',
    do: ['Add loading="lazy" to every image below the first screen — never to the one at the top.'],
    where: group(pages, (i) => /load eagerly$/.test(i.what)),
  })

  push({
    id: 'canonical',
    title: 'Pages without a canonical URL',
    impact: 'medium',
    effort: 'minutes',
    why: 'A page reachable at more than one address — with and without a slash, with a tracking parameter — competes with itself and splits its own ranking between the copies.',
    do: ['Add a self-referencing canonical link to every indexable page.'],
    where: group(pages, (i) => i.what === 'No canonical URL'),
  })

  push({
    id: 'orphan',
    title: 'Pages that are nearly dead ends',
    impact: 'medium',
    effort: 'an hour',
    why: 'Internal links are how ranking strength moves around a site and how a crawler finds the rest of it. A page with almost none receives nothing and passes nothing on.',
    do: [
      'Link out to the three or four pages a reader of this one would want next.',
      'Write the anchor as the target page\'s term — "talent representation", never "click here".',
    ],
    where: group(pages, (i) => /^Only \d+ internal links?$/.test(i.what)),
  })

  push({
    id: 'share',
    title: 'Incomplete share cards',
    impact: 'low',
    effort: 'minutes',
    why: 'A link shared into a group chat or a Slack without og:title and og:image renders as a bare URL. Almost nobody clicks a bare URL.',
    do: ['Add og:title, og:description and a 1200x630 og:image to each.'],
    where: group(pages, (i) => i.what === 'Incomplete share card'),
  })

  push({
    id: 'broken',
    title: 'Pages the sitemap points at that do not answer',
    impact: 'high',
    effort: 'minutes',
    why: 'A crawler follows the sitemap first. A URL in it that 404s spends crawl budget on nothing and tells Google the list is unreliable.',
    do: ['Fix the route, or take the URL out of sitemap.xml.'],
    where: group(pages, (i) => /^Returns \d+$|Could not be fetched/.test(i.what)),
  })

  if (audit.duplicateTitles?.length) {
    found.push({
      id: 'dupe-titles',
      title: 'Pages sharing a title',
      impact: 'high',
      effort: 'minutes',
      why: 'Two pages with the same title ask Google to rank them for the same thing. Google picks one and suppresses the other, and it does not ask which one you wanted.',
      do: ['Give each a title naming what only it covers.'],
      where: audit.duplicateTitles.flatMap((d) => d.where),
      evidence: audit.duplicateTitles.map((d) => `"${d.text}" on ${d.where.join(', ')}`),
    })
  }

  if (audit.duplicateDescriptions?.length) {
    found.push({
      id: 'dupe-descriptions',
      title: 'Pages sharing a meta description',
      impact: 'medium',
      effort: 'minutes',
      why: 'A repeated description is a signal the pages are near-duplicates, and it wastes the one line of copy you fully control in the result.',
      do: ['Write a distinct description per page.'],
      where: audit.duplicateDescriptions.flatMap((d) => d.where),
      evidence: audit.duplicateDescriptions.map((d) => `"${d.text.slice(0, 60)}..." on ${d.where.join(', ')}`),
    })
  }

  const order = { high: 0, medium: 1, low: 2 }
  return found.sort((a, b) => order[a.impact] - order[b.impact] || b.where.length - a.where.length)
}

// ----------------------------------------------------- what search says
//
// Only ever built from real Search Console rows. With no connection this
// returns nothing at all, and the portal says why rather than filling the
// space with something that looks like data.

function fromSearch(search) {
  if (!search?.connected || !search.keywords?.length) return []
  const found = []

  const underClicked = search.keywords.filter((k) => k.underClicked).slice(0, 12)
  if (underClicked.length) {
    found.push({
      id: 'under-clicked',
      title: 'Ranking on page one, and being scrolled past',
      impact: 'high',
      effort: 'an hour',
      why: 'These terms already rank where they can be seen. The position is not the problem — the title and description are, and rewriting those is the cheapest traffic on this page.',
      do: [
        'Open each page in a search result and read the two lines as a stranger would.',
        'Rewrite the title so the term appears in the first half.',
        'Rewrite the description as a reason to click, not a summary.',
      ],
      where: [...new Set(underClicked.map((k) => k.term))],
      evidence: underClicked.map(
        (k) => `"${k.term}" — position ${k.position.toFixed(1)}, ${k.impressions} impressions, ${(k.ctr * 100).toFixed(1)}% clicked`
      ),
    })
  }

  const reach = search.keywords.filter((k) => k.withinReach).slice(0, 12)
  if (reach.length) {
    found.push({
      id: 'striking-distance',
      title: 'Sitting on page two, within reach of page one',
      impact: 'high',
      effort: 'a day',
      why: 'Position 11 to 20 is the most expensive place on the internet: full demand behind the term, almost no clicks in front of it. Moving one of these up three places is worth more than winning a new term outright.',
      do: [
        'Find the page already ranking for the term and make it the best answer, not a mention.',
        'Add a section that answers the term as a question, under an h2 in those words.',
        'Link to it from two or three related pages, with the term as the anchor.',
      ],
      where: [...new Set(reach.map((k) => k.term))],
      evidence: reach.map((k) => `"${k.term}" — position ${k.position.toFixed(1)}, ${k.impressions} impressions`),
    })
  }

  const invisible = search.pages?.filter((p) => p.impressions >= 50 && p.clicks === 0).slice(0, 8) || []
  if (invisible.length) {
    found.push({
      id: 'seen-not-clicked',
      title: 'Pages seen in search and never clicked',
      impact: 'medium',
      effort: 'an hour',
      why: 'Real demand is reaching these and turning away at the listing. That is a promise problem in the title, or a position too low to be read.',
      do: ['Rewrite the title and description.', 'Check what is ranking above them and what it offers that this does not.'],
      where: invisible.map((p) => {
        try {
          return new URL(p.url).pathname
        } catch {
          return p.url
        }
      }),
      evidence: invisible.map((p) => `${p.impressions} impressions, 0 clicks, average position ${p.position.toFixed(1)}`),
    })
  }

  return found
}

// -------------------------------------------------- what the visits say

function fromTraffic(traffic) {
  if (!traffic?.measuring) return []
  const found = []
  const total = traffic.totals

  if (total.views >= 50) {
    const mobileShare = total.views ? (traffic.devices.find((d) => d.name === 'mobile')?.count || 0) / total.views : 0
    if (mobileShare > 0.6) {
      found.push({
        id: 'mobile-first',
        title: `${Math.round(mobileShare * 100)}% of visits are on a phone`,
        impact: 'high',
        effort: 'ongoing',
        why: 'Google indexes the mobile rendering of a page and ignores the desktop one. On this site the readers agree with it, so every judgement about layout, image weight and tap targets should be made on a phone first.',
        do: [
          'Review every page at 390px wide before shipping it.',
          'Check Largest Contentful Paint on a throttled mobile connection, not on the laptop it was built on.',
          'Keep tap targets at 44px and text at 16px minimum, so no browser zooms the page on focus.',
        ],
        where: [],
        evidence: [`${traffic.devices.map((d) => `${d.name} ${d.count}`).join(', ')} over ${traffic.window.days} days`],
      })
    }

    const organic = traffic.channels.find((c) => c.name === 'organic')?.count || 0
    if (organic / total.views < 0.15) {
      found.push({
        id: 'organic-share',
        title: `Search is sending ${Math.round((organic / total.views) * 100)}% of the traffic`,
        impact: 'high',
        effort: 'ongoing',
        why: 'Every other channel needs pushing to keep producing. Search is the only one that compounds — and at this share the site is being read but not being found.',
        do: [
          'Work the striking-distance terms first: they are demand already pointed at you.',
          'Publish the informational cluster — it is where search traffic for a site this size actually comes from.',
          'Check Search Console coverage: a page that is not indexed cannot be found at any position.',
        ],
        where: [],
        evidence: [`${organic} of ${total.views} views from search over ${traffic.window.days} days`],
      })
    }

    const worstExit = traffic.exits?.[0]
    if (worstExit && total.sessions >= 20 && worstExit.count / total.sessions > 0.3) {
      found.push({
        id: 'exit-page',
        title: `${worstExit.name} is where most visits end`,
        impact: 'medium',
        effort: 'an hour',
        why: 'A page can be a fine last page — a confirmation, a contact form sent. If this one is not, then it is the page where the site stops giving anyone a reason to continue.',
        do: [
          'Read it to the bottom and ask what the obvious next step is.',
          'If there is not one, add it: the next page, in the reader\'s own order.',
        ],
        where: [worstExit.name],
        evidence: [`${worstExit.count} of ${total.sessions} sessions ended here`],
      })
    }

    const shallow = traffic.avgScroll
    if (typeof shallow === 'number' && shallow > 0 && shallow < 45) {
      found.push({
        id: 'scroll-depth',
        title: `The average visit reaches ${Math.round(shallow)}% down the page`,
        impact: 'medium',
        effort: 'a day',
        why: 'Everything below that line is being written for nobody. It is also, usually, where the proof and the call to action have been put.',
        do: [
          'Move the single most persuasive thing on each page above the fold.',
          'Shorten the run-up: cut the first section in half and see whether anything is lost.',
        ],
        where: [],
        evidence: [`${Math.round(shallow)}% average scroll depth across ${total.views} views`],
      })
    }
  }

  return found
}

// ------------------------------------------------------------ the strategy
//
// Written, not measured, and marked as such wherever it is shown. These are
// the structural moves for this site specifically — the things no crawl can
// find because they are about what is not there.

export const STRUCTURAL = [
  {
    id: 'journal',
    title: 'Build somewhere to answer a question',
    impact: 'high',
    effort: 'ongoing',
    why: 'This is the largest single gap. Every page on the site sells something, and almost all search volume in this category is people asking how to do something. There is currently nowhere on createspacebrand.com for an answer to live, so that traffic has nowhere to land — which caps organic growth no matter how well the existing pages are optimised.',
    do: [
      'Add /journal/ with an index and one page per answer.',
      'Start with six from the "Getting started" cluster: how to make a media kit, what to charge for UGC, how to pitch a brand, how to start with no audience, what a creator manager actually does, what to check in a brand contract.',
      'One question per page, answered in full, in the house voice. Not a blog — a reference.',
      'Article schema on each, and a link from each to the service page it naturally leads to.',
      'Add them to sitemap.xml as they ship.',
    ],
  },
  {
    id: 'entity',
    title: 'Make the brand one entity to Google, not several',
    impact: 'high',
    effort: 'an hour',
    why: 'The name appears as "createspace", "createspace brand" and "createspace · community + talent" across the site and every social profile. Without something tying them together, Google treats them as possibly-different things and gives none of them a knowledge panel.',
    do: [
      'One Organization block in the homepage JSON-LD with name, alternateName, logo, and sameAs listing every profile URL — Instagram, TikTok, LinkedIn, YouTube.',
      'Use the identical name string in the same place on every page.',
      'Claim the Google Business Profile if there is any physical or service area.',
      'Point every profile\'s bio link at createspacebrand.com, not at a link aggregator — an aggregator absorbs the link equity instead of passing it.',
    ],
  },
  {
    id: 'internal-links',
    title: 'Link the two divisions to each other deliberately',
    impact: 'medium',
    effort: 'an hour',
    why: 'Community and Talent are separate journeys that share an audience, and the shop sits beside both. Right now a reader has to use the nav to cross between them, which means the crawler learns nothing about how the pages relate.',
    do: [
      'From /creators/ link to /talent/ with the anchor "talent representation".',
      'From /talent/ link to /brands/ with "brand partnerships".',
      'From every product page link to the service the product is a smaller version of.',
      'Write anchors as the target page\'s term. Never "learn more".',
    ],
  },
  {
    id: 'sitemap',
    title: 'Give the sitemap dates',
    impact: 'low',
    effort: 'minutes',
    why: 'The sitemap lists 25 URLs and nothing else. lastmod tells a crawler which pages are worth re-reading, and without it every crawl is a guess.',
    do: [
      'Add <lastmod> to each entry and update it when the page changes.',
      'Keep noindex pages out of it entirely — the checkout, the order page, the stockroom, this portal.',
    ],
  },
  {
    id: 'proof',
    title: 'Put proof on the pages that ask for money',
    impact: 'medium',
    effort: 'a day',
    why: 'Not a ranking factor directly, and the largest lever on this list all the same. Search sends a stranger to a page that asks them to apply or to buy. Rankings decide how many arrive; the page decides what happens next.',
    do: [
      'Named results with numbers on /brands/ and /talent/.',
      'Real creator names and outcomes on /creators/, with permission.',
      'A specific price or a range wherever there is one — a missing price is a bounce, not a mystery.',
      'Review schema on products, once there are real reviews. Never before.',
    ],
  },
  {
    id: 'speed',
    title: 'Hold the ground the site already has on speed',
    impact: 'low',
    effort: 'ongoing',
    why: 'This site is a static build with self-hosted variable fonts, no framework and hard-cached assets — a genuinely strong position that is easy to give away one script at a time.',
    do: [
      'Keep third-party scripts off the site. The analytics here is first-party for exactly this reason.',
      'Keep serving WebP with a JPEG fallback and keep the 1200px cap.',
      'Bump the ?v= fingerprint in the same commit as any CSS or JS change, per the caching rule in the README.',
      'Re-check Core Web Vitals in Search Console after any change to the header or hero.',
    ],
  },
  {
    id: 'authority',
    title: 'Earn links from where creators already read',
    impact: 'high',
    effort: 'ongoing',
    why: 'On-page work sets the ceiling; links decide how close to it you get. For a category term like "creator management company", the gap between this site and the ones above it is almost entirely links.',
    do: [
      'Get listed in creator-economy directories and agency roundups — these are the easiest relevant links in this category.',
      'Offer the founder for podcast interviews; the show notes link is the point.',
      'Publish one piece of original data a year — even fifty surveyed creators is citable, and citations are how a small site earns links it did not ask for.',
      'Ask represented talent to link the site from their own pages, where they have one.',
    ],
  },
]

// Everything, in the order it should be worked.
export function buildPlaybook({ audit, search, traffic }) {
  const findings = [...fromAudit(audit), ...fromSearch(search), ...fromTraffic(traffic)]
  const order = { high: 0, medium: 1, low: 2 }
  return {
    findings: findings.sort((a, b) => order[a.impact] - order[b.impact]),
    structural: STRUCTURAL,
    keywords: KEYWORD_MAP,
    counts: {
      findings: findings.length,
      high: findings.filter((f) => f.impact === 'high').length,
      pagesTouched: [...new Set(findings.flatMap((f) => f.where))].length,
    },
  }
}

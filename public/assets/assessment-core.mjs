// The service-fit assessment — the rules, shared by the page and the desk.
//
// Seven questions, each answer weighted toward the nine done-for-you
// services in netlify/shared/services.mjs. The page scores in the browser so
// the result appears the moment the last answer is in; the desk scores the
// same answers again server-side and trusts only its own result. Same file,
// same numbers, so the two can never disagree.
//
// Plain ESM with no imports: the browser loads it as a module, the function
// bundles it, and the tests read it under node. Names, turnarounds and blurbs
// mirror the catalog — netlify/shared/assessment.test.mjs asserts they still do.

export const SERVICE_ORDER = Object.freeze([
  'visual-brand-kit',
  'storefront-buildout',
  'content-system-setup',
  'creator-intensive',
  'profile-rebrand',
  'social-strategy-sprint',
  'brand-architecture',
  'organizational-systems',
  'engagement-action-plan',
])

export const SERVICE_COPY = Object.freeze({
  'visual-brand-kit': {
    name: 'Visual Brand Kit', tier: '03', turnaround: '2–3 weeks',
    blurb: 'A done-for-you visual identity system — palette, type, templates, the cohesive look.',
    fits: 'You are building the look from the ground up, or from pieces that were never a system, and you want it handed over finished.',
    first: 'Book it — fixed price, two to three weeks',
  },
  'storefront-buildout': {
    name: 'Storefront Buildout', tier: '03', turnaround: '1–2 weeks',
    blurb: 'Stan Store or link-in-bio built and styled, ready to sell from day one.',
    fits: 'You have something to sell and nowhere of your own to sell it from. The shop is the missing piece, not the brand.',
    first: 'Book it — fixed price, one to two weeks',
  },
  'content-system-setup': {
    name: 'Content System Setup', tier: '03', turnaround: '2 weeks',
    blurb: 'A content calendar and template system built for you, not handed to you.',
    fits: 'The look is fine; the rhythm is not. You want a planning system in the tools you already open, and the handover that makes it yours.',
    first: 'Book it — fixed price, two weeks',
  },
  'creator-intensive': {
    name: 'Creator Intensive', tier: '03', turnaround: '1 week',
    blurb: 'A done-with-you strategy session plus a written, personalised roadmap.',
    fits: 'There is a decision you keep circling. One session in the room, a written roadmap, and a follow-up on a date.',
    first: 'Book it — fixed price, one week',
  },
  'profile-rebrand': {
    name: 'Profile Rebrand', tier: '03', turnaround: '2–3 weeks',
    blurb: 'Full profile optimisation and visual rebrand across your platform.',
    fits: 'Your profile does not say what you do. Positioning and bio rewritten, the grid and highlights repassed, what survives kept on purpose.',
    first: 'Book it — fixed price, two to three weeks',
  },
  'social-strategy-sprint': {
    name: 'Social Strategy Sprint', tier: '04', turnaround: '2 weeks',
    blurb: 'A full 30-day content plan for your account, built on real research rather than a template.',
    fits: 'You want the next thirty days planned post by post, on research into what your audience has already said yes to.',
    first: 'Request the scope — written before any price exists',
  },
  'brand-architecture': {
    name: 'Personal Brand Architecture', tier: '04', turnaround: '6–10 weeks',
    blurb: 'The five layers of a personal brand, built on what is actually true about you.',
    fits: 'You want the whole thing built properly, over a season: positioning on your own convictions, the system that carries it, the offers named honestly.',
    first: 'Request the scope — written before any price exists',
  },
  'organizational-systems': {
    name: 'Organizational Systems', tier: '04', turnaround: '3–4 weeks',
    blurb: 'The working world behind the work — mapped, rebuilt and handed over.',
    fits: 'The back office is on fire: too many tools, nothing in one place, and nobody could take it over tomorrow.',
    first: 'Request the scope — written before any price exists',
  },
  'engagement-action-plan': {
    name: 'Engagement Action Plan', tier: '04', turnaround: '1 week',
    blurb: 'Thirty content ideas for your month, researched against your niche and the accounts you admire.',
    fits: 'Ideas run dry by Wednesday and you need a month of them this week — hooks, formats, motion, CTAs, with the mechanics credited.',
    first: 'Request the scope — written before any price exists',
  },
})

// Each option: the words on the card, the points it adds, and the clause the
// result quotes back ("because you said …").
export const QUESTIONS = Object.freeze([
  {
    id: 'where', ask: 'Where are you right now?',
    options: [
      { key: 'starting', label: 'Starting out', small: 'An audience in mind — not yet a brand.', because: 'you are starting out',
        adds: { 'visual-brand-kit': 3, 'profile-rebrand': 2, 'creator-intensive': 2 } },
      { key: 'inconsistent', label: 'Posting, but it does not hang together', small: 'The look and the voice change week to week.', because: 'what you post does not yet hang together',
        adds: { 'profile-rebrand': 3, 'visual-brand-kit': 2, 'content-system-setup': 1 } },
      { key: 'selling', label: 'Established, with something to sell', small: 'And nowhere of my own to sell it.', because: 'you have something to sell and nowhere of your own to sell it',
        adds: { 'storefront-buildout': 3, 'brand-architecture': 1 } },
      { key: 'onfire', label: 'Growing — and the back office is on fire', small: 'Too many tools, too much in my head.', because: 'the back office is on fire',
        adds: { 'organizational-systems': 3, 'content-system-setup': 2 } },
    ],
  },
  {
    id: 'change', ask: 'What would change the most in the next thirty days?',
    options: [
      { key: 'plan', label: 'Knowing what to post, and when', small: 'A rhythm I can keep.', because: 'knowing what to post would change the most',
        adds: { 'content-system-setup': 3, 'social-strategy-sprint': 2, 'engagement-action-plan': 2 } },
      { key: 'look', label: 'A look people recognise', small: 'Palette, type, the cohesive thing.', because: 'a look people recognise would change the most',
        adds: { 'visual-brand-kit': 3, 'profile-rebrand': 2 } },
      { key: 'money', label: 'Money moving through a place I own', small: 'Offers, priced, on my own storefront.', because: 'money moving through a place you own would change the most',
        adds: { 'storefront-buildout': 3 } },
      { key: 'decision', label: 'A clear decision on what I am building', small: 'The one I keep circling.', because: 'a clear decision would change the most',
        adds: { 'creator-intensive': 3, 'brand-architecture': 2 } },
    ],
  },
  {
    id: 'how', ask: 'How do you like to work?',
    options: [
      { key: 'forme', label: 'Done for me', small: 'Hand me the finished thing.', because: 'you want it done for you',
        adds: { 'visual-brand-kit': 1, 'storefront-buildout': 1, 'profile-rebrand': 1, 'engagement-action-plan': 1 } },
      { key: 'withme', label: 'Done with me', small: 'I want to be in the room.', because: 'you want to be in the room',
        adds: { 'creator-intensive': 3, 'brand-architecture': 1 } },
      { key: 'teach', label: 'Teach me the system', small: 'Then let me run it.', because: 'you want a system you run yourself',
        adds: { 'content-system-setup': 2, 'organizational-systems': 2 } },
      { key: 'research', label: 'Research it properly', small: 'Then hand me the plan.', because: 'you want it researched properly first',
        adds: { 'social-strategy-sprint': 3, 'engagement-action-plan': 2 } },
    ],
  },
  {
    id: 'horizon', ask: 'What is your time horizon?',
    options: [
      { key: 'week', label: 'This week', small: 'I need a win.', because: 'you need a win this week',
        adds: { 'engagement-action-plan': 3, 'creator-intensive': 2, 'storefront-buildout': 1 } },
      { key: 'fortnight', label: 'A fortnight', small: 'Two weeks, then live.', because: 'you are working to a fortnight',
        adds: { 'content-system-setup': 2, 'social-strategy-sprint': 2, 'storefront-buildout': 1 } },
      { key: 'month', label: 'A month or so', small: 'Built properly, not rushed.', because: 'you have a month or so',
        adds: { 'visual-brand-kit': 2, 'profile-rebrand': 2, 'organizational-systems': 1 } },
      { key: 'season', label: 'A season', small: 'I want it built to last.', because: 'you want it built over a season',
        adds: { 'brand-architecture': 3, 'organizational-systems': 2 } },
    ],
  },
  {
    id: 'ache', ask: 'Which of these keeps you up?',
    options: [
      { key: 'profile', label: 'My profile does not say what I do', small: 'People land, and leave unsure.', because: 'your profile does not say what you do',
        adds: { 'profile-rebrand': 3, 'brand-architecture': 1 } },
      { key: 'ideas', label: 'Ideas run dry by Wednesday', small: 'Monday is fine. Then nothing.', because: 'ideas run dry by Wednesday',
        adds: { 'engagement-action-plan': 3, 'social-strategy-sprint': 1 } },
      { key: 'shop', label: 'Offers, and no storefront', small: 'People ask where to buy. I send a DM.', because: 'you have offers and no storefront',
        adds: { 'storefront-buildout': 3 } },
      { key: 'tools', label: 'Too many tools, nothing in one place', small: 'Notes here, files there, invoices somewhere.', because: 'nothing is in one place',
        adds: { 'organizational-systems': 3 } },
      { key: 'who', label: 'I do not know who I am online', small: 'The category is clear. I am not.', because: 'you do not yet know who you are online',
        adds: { 'brand-architecture': 3, 'creator-intensive': 1 } },
    ],
  },
  {
    id: 'visual', ask: 'Do you have a visual identity you would keep?',
    options: [
      { key: 'none', label: 'No — starting from scratch', small: 'Nothing I would carry forward.', because: 'the visual side starts from scratch',
        adds: { 'visual-brand-kit': 3 } },
      { key: 'pieces', label: 'Some pieces, not a system', small: 'A colour I like. A font I keep changing.', because: 'you have pieces but not a system',
        adds: { 'visual-brand-kit': 2, 'profile-rebrand': 1 } },
      { key: 'fine', label: 'Yes — the look is fine', small: 'The words and the plan are not.', because: 'the look is fine and the plan is not',
        adds: { 'social-strategy-sprint': 2, 'brand-architecture': 1, 'content-system-setup': 1 } },
      { key: 'sell', label: 'Yes, and I sell', small: 'The shop needs to match it.', because: 'the shop needs to match a look you already have',
        adds: { 'storefront-buildout': 2 } },
    ],
  },
  {
    id: 'lead', ask: 'How much of this should be research-led?',
    options: [
      { key: 'beautiful', label: 'Just make it beautiful', small: 'I know what I want. Build it.', because: 'you asked for it made beautifully, not studied',
        adds: { 'visual-brand-kit': 1, 'profile-rebrand': 1, 'storefront-buildout': 1 } },
      { key: 'audience', label: 'Read my audience first', small: 'What have they already said yes to?', because: 'you want your audience read first',
        adds: { 'social-strategy-sprint': 3, 'engagement-action-plan': 2 } },
      { key: 'me', label: 'Read me first', small: 'Build it on what is true about me.', because: 'you want it built on what is true about you',
        adds: { 'brand-architecture': 2, 'creator-intensive': 2 } },
      { key: 'work', label: 'Read how I work first', small: 'Then fix the working world.', because: 'you want the way you work read first',
        adds: { 'organizational-systems': 3 } },
    ],
  },
])

const OPTION = (q, key) => q.options.find((o) => o.key === key) || null

/** Keep only answers that name a real question and one of its options. */
export function readAnswers(raw = {}) {
  const answers = {}
  for (const q of QUESTIONS) {
    const key = String(raw?.[q.id] ?? '').trim()
    if (OPTION(q, key)) answers[q.id] = key
  }
  return answers
}

export const complete = (answers) => QUESTIONS.every((q) => Boolean(answers?.[q.id]))

/**
 * Score a full set of answers. Ties go to catalogue order — the fixed-price
 * tier first, because it is the smaller ask and the faster win.
 * Returns null until every question is answered.
 */
export function score(raw = {}) {
  const answers = readAnswers(raw)
  if (!complete(answers)) return null
  const scores = Object.fromEntries(SERVICE_ORDER.map((k) => [k, 0]))
  const because = []
  for (const q of QUESTIONS) {
    const o = OPTION(q, answers[q.id])
    for (const [k, n] of Object.entries(o.adds)) scores[k] += n
    because.push({ key: q.id, option: o.key, text: o.because, adds: o.adds })
  }
  const ranked = [...SERVICE_ORDER].sort((a, b) => scores[b] - scores[a] || SERVICE_ORDER.indexOf(a) - SERVICE_ORDER.indexOf(b))
  const recommended = ranked[0]
  const secondary = ranked[1]
  // The reasons that actually moved the winner — at most three, strongest first.
  const reasons = because
    .filter((b) => b.adds[recommended])
    .sort((a, b) => b.adds[recommended] - a.adds[recommended])
    .slice(0, 3)
    .map((b) => b.text)
  return { answers, scores, ranked, recommended, secondary, reasons }
}

/** Where the result points: the shelf, opened on that service. */
export const servicePath = (key) => `/shop/services/#${key}`

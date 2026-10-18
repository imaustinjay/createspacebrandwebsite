// The careers pages' one source of truth — read by the page (to draw the form
// and the posting's state) and by netlify/functions/careers.mjs (to check what
// arrives). No imports: it runs in the browser and on the server unchanged.
//
// The forms mirror the workspace's own application forms field for field
// (src/data/applications.ts; the ids are pinned by shared/careersCore.mjs
// ROLE_KEYS there). The id lists are held as a vector in
// netlify/shared/careers.test.mjs, and the workspace's careersCore.test.mjs
// holds the same vector — so a field renamed on one side turns both suites
// red on the same commit. Labels may read a little differently on the page;
// the ids may not.
//
// POSTINGS are the defaults. The live window comes from the workspace
// (/api/careers-postings, proxied to createspacebrand.online), where the
// founder edits it in Talent Acquisition → Postings; these dates are what the
// page shows when the workspace cannot be reached.

export const CAREERS_TZ = 'America/Los_Angeles'

export const POSTINGS = Object.freeze([
  Object.freeze({
    slug: 'brand-architect-intern',
    role: 'Brand Architect Intern',
    req: 'CS-REQ-BRA-I01',
    cohort: 'Cohort 01',
    location: 'Remote',
    schedule: 'Part-time · about 15–20 hours a week',
    status: 'active',
    opensAt: '2026-10-13',
    closesAt: '2026-11-30',
    startsAt: '2027-01-11',
  }),
  Object.freeze({
    slug: 'brand-architect-jr',
    role: 'Brand Architect Jr.',
    req: 'CS-REQ-BRA-J01',
    cohort: '',
    location: 'Remote',
    schedule: 'Part-time · about 20–25 hours a week',
    status: 'active',
    opensAt: '2026-11-02',
    closesAt: null,
    startsAt: null,
  }),
  // Two openings, until filled. The term is not posted: every creator starts
  // with a first month, and a longer contract is offered after it.
  Object.freeze({
    slug: 'content-creator',
    role: 'Content Creator (Contract)',
    req: 'CS-REQ-CC-C01',
    cohort: '',
    location: 'Remote',
    schedule: 'Contract · short-form · two pieces a week',
    status: 'active',
    opensAt: '2026-10-17',
    closesAt: null,
    startsAt: null,
  }),
])

/**
 * Where a posting's application lives. Most postings carry their form on the
 * role page; the content creator posting keeps the role page to the role and
 * puts the application and screening on its own page, behind Apply now.
 */
export const APPLY_PATHS = Object.freeze({ 'content-creator': 'careers/content-creator/apply/' })
export const applyPathFor = (slug) => APPLY_PATHS[slug] || `careers/${slug}/`

export const postingFor = (slug) => POSTINGS.find((p) => p.slug === String(slug || '').toLowerCase()) || null

/** Today as a Pacific calendar day, YYYY-MM-DD. */
export function pacificDay(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: CAREERS_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now)
  const get = (t) => parts.find((p) => p.type === t)?.value
  return `${get('year')}-${get('month')}-${get('day')}`
}

/** upcoming · open · closed · paused — the workspace's own rule (careersCore.postingState). */
export function postingState(p, now = new Date()) {
  if (!p) return 'closed'
  if (p.status === 'paused') return 'paused'
  if (p.status === 'closed') return 'closed'
  const today = pacificDay(now)
  const opens = p.opensAt ? String(p.opensAt).slice(0, 10) : null
  const closes = p.closesAt ? String(p.closesAt).slice(0, 10) : null
  if (!opens || today < opens) return 'upcoming'
  if (closes && today > closes) return 'closed'
  return 'open'
}

/** "Monday, November 2" — a posting date in words, read as a Pacific day. */
export function dayInWords(iso, { weekday = true, year = false } = {}) {
  if (!iso) return ''
  const d = new Date(`${String(iso).slice(0, 10)}T12:00:00Z`)
  return d.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric', ...(weekday ? { weekday: 'long' } : {}), ...(year ? { year: 'numeric' } : {}) })
}

const STRENGTHS = ['Colour & palette', 'Typography', 'Layout & composition', 'Writing & voice', 'Strategy & research', 'Social content', 'Art direction']
const CREATOR_FORMATS = ['Talk-to-camera', 'Green screen', 'Voiceover with B-roll', 'Day in the life', 'Text on screen, no talking', 'Recommendations and lists', 'Storytelling']
const CREATOR_GEAR = ['iPhone / smartphone', 'Mirrorless / DSLR', 'Gimbal / stabilizer', 'Lighting kit', 'Audio gear', 'CapCut', 'Premiere / Final Cut / Resolve']
// The screening's right answers live in the workspace (brandCreatorCore SCREENING_KEY); the page only asks.
const SCREENING_CONCEPT = 'A sample concept: “POV: you posted today and nobody watched.” A 7–10 second talk-to-camera piece that ends on “no one builds alone.” Walk us through exactly how you would shoot it, beat by beat.'
const SCREENING_BRIEF = ['Shoot it as written', 'Shoot it as written, and send a note with my idea', 'Shoot it my way — the result matters most', 'Ask first, and wait for an answer before shooting']
const SCREENING_LATE = ['Upload it late without saying anything', 'Tell the team as soon as I know, and agree a new time', 'Skip it this week', 'Upload whatever I have on time']
const SCREENING_HOOK = ['In the first second', 'By the middle', 'At the end', 'A piece that short doesn’t need one']
const TOOLS = ['Figma', 'Adobe Illustrator', 'Adobe Photoshop', 'Adobe InDesign', 'Canva', 'Procreate', 'Notion', 'Other']

/** The shared "About you" chapter — SHARED_ABOUT in the workspace. */
const ABOUT = Object.freeze({
  title: 'About you',
  fields: [
    { id: 'full_name', label: 'Full name', type: 'text', required: true, autocomplete: 'name' },
    { id: 'email', label: 'Email', type: 'email', required: true, autocomplete: 'email' },
    { id: 'phone', label: 'Phone', type: 'tel', autocomplete: 'tel' },
    { id: 'location', label: 'Location', type: 'text', required: true, placeholder: 'City, state or country', autocomplete: 'address-level2' },
    { id: 'pronouns', label: 'Pronouns', type: 'text' },
    { id: 'links', label: 'Portfolio and links', type: 'textarea', placeholder: 'Your site, Behance, Instagram, a Drive folder — whatever shows your work.' },
    { id: 'availability', label: 'When could you start?', type: 'select', required: true, options: ['Available now', 'Within 2 weeks', 'Within a month', 'Just exploring'] },
    { id: 'referral', label: 'How did you hear about createspace?', type: 'text' },
  ],
})

/** Each posting's form, in the workspace's order. */
export const FORMS = Object.freeze({
  'brand-architect-intern': Object.freeze([
    ABOUT,
    {
      title: 'Your eye and your thinking',
      intro: 'We hire for taste and care first. Tools are teachable.',
      fields: [
        { id: 'bai_path', label: 'Where are you on your path?', type: 'select', required: true, options: ['Studying design, branding, marketing or similar', 'Recently graduated', 'Self-taught and building a portfolio', 'Changing careers into brand work', 'Other'] },
        { id: 'bai_portfolio_piece', label: 'One piece of work you’re proud of — link it, and tell us the thinking behind it', type: 'textarea', required: true, hint: 'A school project, a friend’s logo, a page you redesigned for fun — it all counts.' },
        { id: 'bai_brand_admire', label: 'A brand whose identity you admire, and what it gets right', type: 'textarea', required: true },
        { id: 'bai_strengths', label: 'Where does your eye naturally live?', type: 'multiselect', options: STRENGTHS },
        { id: 'bai_tools', label: 'Tools you’re comfortable in', type: 'multiselect', options: TOOLS },
      ],
    },
    {
      title: 'The cohort',
      intro: 'A remote, part-time program works when the hours are honest. Tell us what you can really give.',
      fields: [
        { id: 'bai_hours', label: 'Hours you can give each week, steadily', type: 'select', required: true, options: ['Under 10', '10–15', '15–20', '20+'] },
        { id: 'bai_timezone', label: 'Your time zone', type: 'text', required: true, placeholder: 'Pacific, Eastern, GMT+1…' },
        { id: 'bai_live_sessions', label: 'Can you join two live sessions a week (weekdays, Pacific time)?', type: 'select', required: true, options: ['Yes', 'Mostly', 'Not reliably'] },
        { id: 'bai_why', label: 'Why the Brand Architect cohort, and why createspace?', type: 'textarea', required: true },
        { id: 'bai_feedback', label: 'Tell us about a time feedback changed your work', type: 'textarea', required: true },
      ],
    },
    {
      title: 'A small brief',
      intro: 'No right answer. We want to see where you start.',
      fields: [
        { id: 'bai_brief', label: 'A neighbourhood bakery wants to feel less like a chain and more like a place people belong. In a few sentences, where would you start its brand?', type: 'textarea', required: true },
      ],
    },
  ]),
  'brand-architect-jr': Object.freeze([
    ABOUT,
    {
      title: 'Your work',
      intro: 'Show us something you built, and how you built it.',
      fields: [
        { id: 'baj_years', label: 'Years doing brand or identity work', type: 'select', required: true, options: ['Under 1', '1–2', '3–5', '5+'] },
        { id: 'baj_case', label: 'Walk us through one case — the brief, your decisions, and what shipped (link it)', type: 'textarea', required: true },
        { id: 'baj_systems', label: 'A brand system you built or kept: what it held, and how other people used it', type: 'textarea', required: true },
        { id: 'baj_strengths', label: 'Where are you strongest?', type: 'multiselect', options: STRENGTHS },
        { id: 'baj_tools', label: 'Tools you work in', type: 'multiselect', options: TOOLS },
      ],
    },
    {
      title: 'The house, and the hours',
      fields: [
        { id: 'baj_critique', label: 'Look at createspace’s own presence. One thing you’d keep, one thing you’d change, and why.', type: 'textarea', required: true },
        { id: 'baj_hours', label: 'Hours you can hold each week', type: 'select', required: true, options: ['15–20', '20–25', '25–30'] },
        { id: 'baj_timezone', label: 'Your time zone', type: 'text', required: true, placeholder: 'Pacific, Eastern, GMT+1…' },
        { id: 'baj_cohort', label: 'Are you in, or applying to, the Brand Architect Intern cohort?', type: 'select', options: ['No', 'Yes — in the cohort', 'Yes — applied'] },
        { id: 'baj_why', label: 'Why this seat, and why now?', type: 'textarea', required: true },
      ],
    },
  ]),
  'content-creator': Object.freeze([
    ABOUT,
    {
      title: 'Your content',
      intro: 'Show us short-form organic work you made — posts that live on a page, not paid ads.',
      fields: [
        { id: 'ccc_handle', label: 'Your TikTok and Instagram handles', type: 'text', required: true, placeholder: '@yourname on TikTok, @yourname on Instagram' },
        { id: 'ccc_portfolio', label: 'Links to two or three organic posts you made', type: 'textarea', required: true, hint: 'On your own page or a brand’s. Tell us in a line what each one was for.' },
        { id: 'ccc_styles', label: 'Formats you’re strong in', type: 'multiselect', required: true, options: CREATOR_FORMATS },
        { id: 'ccc_gear', label: 'What you shoot and edit on', type: 'multiselect', options: CREATOR_GEAR },
        { id: 'ccc_gear_detail', label: 'Your core kit, in a line', type: 'text', placeholder: 'iPhone 15 Pro, a ring light, CapCut…' },
      ],
    },
    {
      title: 'The work',
      intro: 'Assignments are short-form — trend-based pieces, specific content concepts and repeatable formats, most 7–10 seconds long — each with links to the content that inspired it. The job is to make it exactly as outlined.',
      fields: [
        { id: 'ccc_direction', label: 'Tell us about a time you made content to someone else’s brief. What did you do when you had a different idea?', type: 'textarea', required: true },
        { id: 'ccc_cadence', label: 'Can you deliver two pieces every week, on a weekly deadline?', type: 'select', required: true, options: ['Yes', 'Most weeks', 'Not reliably'] },
        { id: 'ccc_turnaround', label: 'From a concept to a finished piece, how long do you usually take?', type: 'select', options: ['1–2 days', '3–4 days', 'About a week'] },
      ],
    },
    {
      title: 'Why us',
      fields: [
        { id: 'ccc_why', label: 'Why createspace? What would you bring to our page?', type: 'textarea', required: true },
      ],
    },
    {
      title: 'Screening assessment',
      intro: 'Five short questions about how you work. There’s no trick — we want to see how you think.',
      fields: [
        { id: 'ccc_scr_concept', label: SCREENING_CONCEPT, type: 'textarea', required: true, hint: 'The first second, the shots, the on-screen text and the audio — in order.' },
        { id: 'ccc_scr_trend', label: 'A trend you would make for createspace right now. Link it, and tell us how you would adapt it in 7–10 seconds.', type: 'textarea', required: true },
        { id: 'ccc_scr_brief', label: 'A concept says to open on a close-up, but you think a wide shot would be stronger. What do you do?', type: 'select', required: true, options: SCREENING_BRIEF },
        { id: 'ccc_scr_late', label: 'A piece is due Friday and you’re sick on Thursday. What do you do?', type: 'select', required: true, options: SCREENING_LATE },
        { id: 'ccc_scr_hook', label: 'In a 7–10 second piece, when does the hook need to land?', type: 'select', required: true, options: SCREENING_HOOK },
      ],
    },
  ]),
})

/** Every field id a posting's form carries, in order. */
export const fieldIds = (slug) => (FORMS[slug] || []).flatMap((c) => c.fields.map((f) => f.id))
/** The ids that must be answered. */
export const requiredIds = (slug) => (FORMS[slug] || []).flatMap((c) => c.fields.filter((f) => f.required).map((f) => f.id))

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/
const str = (v, max) => String(v ?? '').trim().slice(0, max)

/**
 * One submission, checked — the page runs it before sending, the server runs
 * it again on what actually arrived. `{ error, field? }` or `{ submission }`.
 * An option outside a select's list is refused; a list keeps only real options.
 */
export function readCareers(body = {}) {
  const posting = postingFor(body.posting)
  if (!posting) return { error: 'That posting isn’t one we have.' }
  const kind = body.kind === 'interest' ? 'interest' : 'application'
  const raw = body.answers && typeof body.answers === 'object' && !Array.isArray(body.answers) ? body.answers : {}
  const name = str(raw.full_name ?? body.name, 160)
  const email = str(raw.email ?? body.email, 254).toLowerCase()
  if (!name) return { error: 'Your name, so we know who we’re talking to.', field: 'full_name' }
  if (!EMAIL_RE.test(email)) return { error: 'That email doesn’t look complete — mind checking it?', field: 'email' }
  if (kind === 'interest') {
    return { submission: { posting: posting.slug, kind, name, email, answers: { full_name: name, email, ...(str(raw.note ?? body.note, 1000) ? { note: str(raw.note ?? body.note, 1000) } : {}) } } }
  }
  const answers = {}
  for (const chapter of FORMS[posting.slug]) {
    for (const f of chapter.fields) {
      let v = raw[f.id]
      if (f.type === 'multiselect') {
        v = (Array.isArray(v) ? v : v ? [v] : []).map((x) => str(x, 120)).filter((x) => f.options.includes(x))
        if (v.length) answers[f.id] = [...new Set(v)]
      } else if (f.type === 'select') {
        v = str(v, 120)
        if (v && !f.options.includes(v)) return { error: `Pick one of the options for “${f.label}”.`, field: f.id }
        if (v) answers[f.id] = v
      } else {
        v = str(v, f.type === 'textarea' ? 4000 : 300)
        if (v) answers[f.id] = v
      }
      if (f.required && !answers[f.id]) return { error: `One more: “${f.label}”.`, field: f.id }
    }
  }
  answers.full_name = name
  answers.email = email
  return { submission: { posting: posting.slug, kind, name, email, answers } }
}

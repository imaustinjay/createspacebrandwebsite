# createspacebrand.com — public marketing site

The public website for **createspace · community + talent**, ported from the
Claude Design handoff (`Createspace_brand_website_design.zip`), plus the
storefront from the second handoff (`Createspace_Storefront_standalone.html`).
Twenty-six real routes, two stylesheets, three serverless functions. The workspace app
(createspacebrand.online) lives in its own repo — `createspace-workspace` —
and deploys separately; the brand context this site is built from is
`reference/PUBLIC_SITE_CONTEXT.md` over there.

## Structure

```
/
  netlify.toml            deploy config — publish dir, functions, redirects
  package.json            deps for the enquiry function only
  netlify/functions/
    enquiry.mjs           brand enquiry → partnerships mailbox (SMTP)
    seasons.mjs           live door status ← workspace casting cycles (anon RLS)
    shop.mjs              every storefront form → the shop mailbox (SMTP)
  public/                 everything served, exactly as-is — no build step
    index.html            Home
    creators/index.html   For creators (Community division)
    talent/index.html     Talent (representation)
    brands/index.html     For brands + enquiry form (#enquire)
    platform/index.html   The platform
    about/index.html      About + founder letter
    privacy/index.html    Privacy — what the site holds, plainly
    contact/index.html    Contact — a person, not a queue
    partnerships/         Partnerships — collaborations, sponsorship, tools
    careers/              Careers — no open roles, plus the alert list
    internships/          Internships — what interns work on, plus the form
    shop/index.html       The shop — hero, the Fall Drop, the craft
    shop/products/        Digital products, then one page per product
    shop/the-craft/       the craft — the membership
    shop/workshops/       The Workshop
    shop/cohort/          The Cohort + interest form
    shop/services/        Done-for-you services
    shop/faq/             FAQ
    shop/account/         Sign up / log in
    shop/checkout/        Three-step checkout (noindex)
    shop/order/           Order confirmation (noindex)
    assets/site.css       tokens (verbatim from reference/PUBLIC_SITE_CONTEXT.md §3) + components
    assets/shop.css       storefront components, in those same tokens
    assets/shop.js        cart, drawer, countdown, FAQ, checkout, forms
    assets/enquiry.js     form submit → /api/enquiry → confirmation state
    assets/seasons.js     fills the door-status slots from /api/seasons
    assets/reveal.js      below-fold sections settle in (house motion verb)
    assets/motion.js      mobile nav, word-staggered headlines, rotating proof line
    assets/fonts/         self-hosted Raleway + Lora italic (variable woff2)
    assets/og.png         share-preview card (dark stage + lockup)
    404.html · robots.txt · sitemap.xml · favicon.svg
```

Each page carries its own `<title>` (from the design's `TITLES` map), meta
description, canonical URL and OG tags — the SPA page-switcher from the design
became real routes, per the handoff README.

## Connecting it (Netlify + GitHub)

1. Netlify → **Add new site** → **Import an existing project** → pick this
   repo (`createspacebrandwebsite`). If a Netlify site already exists, link it
   here instead: Site configuration → Build & deploy → **Link repository**.
2. Leave **Base directory** empty. Everything else (publish dir, functions)
   is read from `netlify.toml` at the repo root.
3. Point the custom domain **createspacebrand.com** at the new site.
4. Set the environment variables below, then deploy.

The workspace keeps its own repo, Netlify site and env; the two share nothing
but a read-only view of which application seasons are open (see Supabase,
below). Every application flow itself lives on createspacebrand.online.

## Environment variables (the enquiry form)

| Variable | What it is |
|---|---|
| `PARTNERSHIPS_EMAIL` | Where enquiries land (e.g. the partnerships@ mailbox). Server-side only — deliberately never printed in the client bundle, per the handoff, so it can't be scraped. |
| `SHOP_EMAIL` | Where the storefront's forms land (contact, cohort interest, careers and workshop alerts, internship applications, the Fall Drop list, account reservations). Falls back to `PARTNERSHIPS_EMAIL` if unset. Server-side only, same as above. |
| `MAIL_USER` / `MAIL_PASSWORD` | SMTP login for the sending mailbox (falls back to `TITAN_EMAIL` / `TITAN_PASSWORD`, same convention as the workspace's `shared/mailCore.mjs`). |
| `MAIL_SMTP_HOST` / `MAIL_SMTP_PORT` | Optional; default `smtp.titan.email` : `465`. |
| `MAIL_FROM_NAME` | Optional visible From name; defaults to the house name. |
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` | Powers the live "open now / between seasons" status on the doors — see the next section. Without them the status simply stays hidden; unknown is never shown as closed. |

Every variable must be scoped so **Functions** can read it (Netlify's "All
scopes" default is fine). A variable scoped to Builds only is invisible at
runtime, which looks exactly like a missing variable.

Until the variables are set, the form returns a calm "the enquiry desk isn't
connected yet" message — nothing breaks, nothing is silently dropped. The
storefront's forms behave identically: an unconfigured desk reads as an honest
failure the visitor can retry, never as a confirmation for a message that went
nowhere.

Abuse guards on both functions: a honeypot field, a minimum-fill-time check
(instant submissions are quietly discarded), and a per-IP hourly limit —
5 for the brand enquiry, 8 for the shop desk (durable via Netlify Blobs,
in-memory fallback locally).

## Supabase — the live season doors

`/api/seasons` reads the workspace's open casting cycles, so the doors on the
site say what the Creator Casting console actually has open. Open a cycle
there and the site follows within five minutes; close it and the badge becomes
"Between seasons just now."

**The two values** come from the same Supabase project the workspace uses —
Supabase dashboard → **Project Settings → API**:

| Netlify variable | Supabase field |
|---|---|
| `SUPABASE_URL` | Project URL (`https://<ref>.supabase.co`) |
| `SUPABASE_ANON_KEY` | Project API keys → **`anon` / `public`** |

Use the **anon** key, never `service_role`. The anon key is meant to be public
— the workspace already ships it in its browser bundle — and row-level
security is what actually protects the data: the `cast cycles public read`
policy in the workspace's `creator-casting.sql` exposes only rows with
`status = 'open'` to anon, which is exactly what a visitor is allowed to know.
This site can see no applications, no scores, no letters, and can write
nothing.

**Verify it** by opening `https://createspacebrand.com/api/seasons`:

| Response | Meaning |
|---|---|
| `{"ok":true,...}` | Connected. `null` for a division just means no open cycle. |
| `{"ok":false,"reason":"not-configured"}` | Variables missing, or not scoped to Functions. |
| `{"ok":false,"reason":"rejected","status":401}` | Wrong key. `403` = anon read policy missing; `404` = table not in this project. |
| `{"ok":false,"reason":"unreachable"}` | Project URL wrong, or the project is paused. |

Failures are never cached, so a fix shows on the very next request. Successes
are cached five minutes at the CDN.

## The shop

`/shop/*` plus Contact, Partnerships, Careers and Internships come from the
storefront handoff. The SPA in that file became real routes, the same way the
first handoff did — one page per screen, the cart carried in `localStorage`,
the order handed to the confirmation page through `sessionStorage`.

**It is drawn in the house's tokens, not the handoff's.** The storefront
mock shipped its own near-identical palette (`#FCFBE9` / `#3B2419` / `#D89BB0`
/ `#4F6B58`) and its own type (Jost, Questrial, Playfair Display). Those map
one-to-one onto ivory / seal / dusk / sage and onto Raleway + Lora italic, so
the shop was built on the existing tokens rather than forking the site's
identity into a second brand two clicks from the front door. `site.css` is
untouched; everything new lives in `shop.css`.

The existing pages gained exactly two lines each: a `Shop` entry in the nav and
a `Shop` link in the footer's House column. Nothing else about them changed.

### Still to wire

- **Stripe.** There is no payment integration yet, so `/shop/checkout/` is a
  working front end with nothing behind it: no session, no charge, no receipt.
  Every price in the handoff is an em-dash for the same reason. The checkout
  and the confirmation each carry a `.preview-note` saying so plainly, and card
  details are never stored, never persisted and never sent anywhere. **Delete
  those two notes in the same change that wires Stripe** — and not before.
- **Accounts.** `/shop/account/` reserves the address for launch day rather
  than pretending to create an account. The password is validated in the
  browser and never leaves it — `shop.js` strips it from the payload and the
  function has no field for it.
- **Downloads.** The confirmation lists what was bought with its Download
  button disabled, because the files unlock on August 17 and a live-looking
  link that 404s is the one thing that page can't afford.
- **Product photography.** Every product shot is a labelled striped frame, the
  same convention the rest of the site uses for imagery that doesn't exist yet.
- **The three role addresses** on Contact (`hello@`, `partners@`, `press@`) are
  published as `mailto:` links, per the design. They need to exist, or be
  changed, before launch.

## Caching — read before changing an asset

Stylesheets and scripts are served `max-age=0, must-revalidate`, so a returning
visitor always revalidates and can never pair new HTML with stale CSS. ETags
make the usual answer a 304, so the cost is negligible. Fonts are immutable
under their filenames and cached for a year.

This matters because it went wrong once: `/assets/*` was originally cached hard
for seven days, and the 2026-07-30 deploy served new HTML with week-old CSS —
the vignettes rendered as unstyled text and the mobile menu button appeared raw.
If you ever reintroduce a long `max-age` on CSS or JS, add a fingerprint to the
filename in the same change.

The `?v=` query on the asset links is a one-time cache-buster for visitors who
were already holding the old seven-day cache. It doesn't need bumping on every
deploy now that revalidation is on — only if a long cache is reintroduced.

## Browser support

Targets current Chrome, Safari, Firefox and Edge, degrading rather than
breaking on older ones:

- **Container queries** size the engine vignettes. Every `cqw` declaration is
  preceded by a px fallback, so a browser without support renders a slightly
  tighter but complete card instead of unstyled text. Verified by stripping
  every `cqw` line and re-rendering.
- **Cross-document view transitions** are progressive: unsupported browsers
  simply navigate.
- `100svh`, `backdrop-filter`, `appearance` and `text-size-adjust` all carry
  fallbacks or `-webkit-` prefixes.
- On phones the ambient background washes stop drifting and blur less — a
  large blurred fixed layer is the most expensive thing iOS repaints per
  scroll frame, and at that size the drift wasn't perceptible.

## Local preview

```bash
npx -y serve public          # pages only
npx -y netlify-cli dev       # pages + the serverless functions
```

## Still open (from the handoff, on purpose)

- **Photography** — one frame still awaits a real asset: the founder portrait
  on About. Home and The platform carry engine vignettes instead (see below),
  so no striped placeholders remain anywhere else.
- **Engine vignettes** (`.vig-*` in `site.css`) draw the media kit, deal room
  and invoice as they actually exist in the workspace — structure, labels and
  status semantics lifted from `KitSheet.tsx`, `PitchDetail.tsx` and
  `UgcInvoiceStudio.tsx`. They are drawn in type and tokens, not
  screenshotted, so they stay crisp and need no re-capture when the product
  moves. Figures are illustrative and each frame says so in its caption. If
  the product's own labels change, update these to match — a vignette that
  drifts from the real interface stops being honest.
- **No roster grid**, by decision — only alongside real names and portraits.
- Commission percentages and the 90/10 split stay qualitative, by decision.
- The privacy page is a plain-words draft in the house voice — worth a
  founder read-through before treating it as policy.

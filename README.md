# createspacebrand.com — public marketing site

The public website for **createspace · community + talent**, ported from the
Claude Design handoff (`Createspace_brand_website_design.zip`), plus the
storefront from the second handoff (`Createspace_Storefront_standalone.html`).
Twenty-eight real routes, two stylesheets, nine serverless functions. The workspace app
(createspacebrand.online) lives in its own repo — `createspace-workspace` —
and deploys separately; the brand context this site is built from is
`reference/PUBLIC_SITE_CONTEXT.md` over there.

## Structure

```
/
  netlify.toml            deploy config — publish dir, functions, redirects
  package.json            deps for the serverless functions (mail + Stripe)
  netlify/shared/         imported by the functions; never deployed as one
    catalog.mjs           the shelf, the Stripe client, and price → money
    mail.mjs              the house mailer (SMTP), shared by the webhook
    storage.mjs           product files, their manifests, and orders (Blobs)
  netlify/functions/
    enquiry.mjs           brand enquiry → partnerships mailbox (SMTP)
    seasons.mjs           live door status ← workspace casting cycles (anon RLS)
    shop.mjs              every storefront form → the shop mailbox (SMTP)
    catalog.mjs           GET  /api/catalog — live shelf prices from Stripe
    checkout.mjs          POST /api/checkout — cart → a client secret, paid on-site
    order.mjs             GET  /api/order — one order read back from Stripe
    stripe-webhook.mjs    POST /api/stripe-webhook — payment → files + inbox
    download.mjs          GET  /api/download — a file, to a paid download token
    products.mjs               /api/products — the stockroom (ADMIN_TOKEN)
  public/                 everything served, exactly as-is — no build step
    index.html            Home
    creators/index.html   For creators (Community division)
    talent/index.html     Talent (representation)
    brands/index.html     For brands + enquiry form (#enquire)
    platform/index.html   The platform
    about/index.html      About + founder letter
    privacy/index.html    Privacy — what the site holds, plainly
    terms/index.html      Terms of service — the house rules, plainly
    contact/index.html    Contact — a person, not a queue
    collection/           The Collection Program — the paid Community cohort
    partnerships/         Partnerships — collaborations, sponsorship, tools
    careers/              Careers — no open roles, plus the alert list
    internships/          Internships — what interns work on, plus the form
    shop/index.html       The shop — hero, the Fall Drop, the craft
    shop/products/        Digital products, then one page per product
    shop/the-craft/       the craft — the membership
    shop/workshops/       The Workshop
    shop/services/        Done-for-you services
    shop/faq/             FAQ
    shop/account/         Sign up / log in
    shop/checkout/        Three-step checkout — payment included (noindex)
    shop/order/           Order confirmation + downloads (noindex)
    shop/admin/           The stockroom — product files (noindex, unlinked)
    assets/site.css       tokens (verbatim from reference/PUBLIC_SITE_CONTEXT.md §3) + components
    assets/shop.css       storefront components, in those same tokens
    assets/shop.js        cart, drawer, live prices, countdown, FAQ, checkout, forms
    assets/admin.js       the stockroom's upload/list/link behaviour
    assets/enquiry.js     form submit → /api/enquiry → confirmation state
    assets/seasons.js     fills the door-status slots from /api/seasons
    assets/collection.js  live cycle state + notify list, from /api/cohort-status
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

## Environment variables

| Variable | What it is |
|---|---|
| `STRIPE_SECRET_KEY` | The storefront's whole payment integration hangs off this one value (`sk_test_…` then `sk_live_…`). Unset, no price is shown anywhere and the pay button says so — see [Stripe — the checkout](#stripe--the-checkout). Server-side only; it must never appear in a page. |
| `STRIPE_PUBLISHABLE_KEY` | The matching `pk_test_…` / `pk_live_…`. It is public by design — it is what lets Stripe's payment field render inside our checkout. Without it the checkout stays closed and says which key is missing in the function log. |
| `STRIPE_WEBHOOK_SECRET` | The signing secret of the webhook endpoint at `/api/stripe-webhook`. Without it, payments still succeed but **nothing is delivered**: no files, no buyer email, no house notification. |
| `ADMIN_TOKEN` | Opens `/shop/admin/`, where the product files are uploaded. 24+ random characters. Unset, the stockroom is shut rather than open — see [Digital delivery](#digital-delivery--the-stockroom). |
| `STRIPE_PRICE_*` | Optional, one per product (`STRIPE_PRICE_START_SMALL`, …). Only needed if the prices don't carry lookup keys; an env var wins where both exist. |
| `STRIPE_AUTOMATIC_TAX` | Optional, `true` to turn on Stripe Tax. Off by default — it needs Stripe Tax configured on the account first, and it makes a billing address required at checkout. |
| `STRIPE_CRAFT_TRIAL_UNTIL` | Optional ISO date for the craft's subscription trial, so "nothing is charged before August 17" is enforced rather than promised. Ignored once it's in the past. |
| `PARTNERSHIPS_EMAIL` | Where brand enquiries land. Optional override — unset, they go to the house inbox, `hello@createspacebrand.com`. Server-side only — deliberately never printed in the client bundle, per the handoff, so it can't be scraped. |
| `SHOP_EMAIL` | Where the storefront's forms land (contact, careers and workshop alerts, internship applications, the Fall Drop list, account reservations, and the Collection Program notify list when the workspace endpoint can't be reached). Optional override — falls back to `PARTNERSHIPS_EMAIL`, then to `hello@createspacebrand.com`. Server-side only, same as above. |
| `MAIL_USER` / `MAIL_PASSWORD` | SMTP login for the sending mailbox (falls back to `TITAN_EMAIL` / `TITAN_PASSWORD`, same convention as the workspace's `shared/mailCore.mjs`). |
| `MAIL_SMTP_HOST` / `MAIL_SMTP_PORT` | Optional; default `smtp.titan.email` : `465`. |
| `MAIL_FROM_NAME` | Optional visible From name; defaults to the house name. |
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` | Powers the live "open now / between seasons" status on the doors — see the next section. Without them the status simply stays hidden; unknown is never shown as closed. |

Every variable must be scoped so **Functions** can read it (Netlify's "All
scopes" default is fine). A variable scoped to Builds only is invisible at
runtime, which looks exactly like a missing variable.

Until the SMTP variables are set, the form returns a calm "the enquiry desk
isn't connected yet" message — nothing breaks, nothing is silently dropped. The
storefront's forms behave identically: an unconfigured desk reads as an honest
failure the visitor can retry, never as a confirmation for a message that went
nowhere.

Abuse guards on both mail functions: a honeypot field, a minimum-fill-time check
(instant submissions are quietly discarded), and a per-IP hourly limit —
5 for the brand enquiry, 8 for the shop desk (durable via Netlify Blobs,
in-memory fallback locally). `/api/checkout` carries the same per-IP limit at
20/hour: a person can legitimately reach the payment page several times in an
hour, and being locked out mid-purchase is the most expensive error it could
make.

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

## The Collection Program — `/collection/`

The paid cohort of the Community division: eight weeks, twenty seats, $497 for
a member and $647 direct ($497 seat + a $150 non-member fee). It replaced the
storefront's placeholder "The Cohort" page, which was mid-ticket copy with an
interest form and no product behind it; `/shop/cohort/*` now 301s here.

**The page never states a date, a price or a status of its own.** What the
program *is* — the shape, the week-by-week arc, the cadence, the two prices as
prose, the terms — is static copy. Everything time-sensitive is read live from
the workspace at request time, because a hardcoded "applications open March
1st" is how a marketing site ends up lying about its own product.

Never hardcode here: a start date, an application deadline, a seats-left count,
or an Apply button that renders when no window is open. And **unknown is not
closed** — if the read fails, the page stays on its honest default ("the
program runs in announced cycles, leave your email") rather than rendering a
closed state it can't verify. That is why `collection.js` catches and does
nothing: the default is already the correct answer.

### The connection to the internal space

Everything past the application lives in the workspace at
createspacebrand.online. **No money for a Collection seat moves through this
site** — the storefront's Stripe wiring is a separate integration that knows
nothing about the program, and a seat is still claimed and paid for in the
workspace. No card details touch this site under either.

| Step | Where it happens |
|---|---|
| Read about it, or join the notify list | here, `/collection/` |
| Apply (25 questions, autosaved) | `createspacebrand.online/cohort` |
| A person reads it; an acceptance letter goes out | the workspace's cohort console |
| Seven days to claim the seat — claiming is paying | the workspace, via Stripe |
| Welcome letter → the portal; Week 0 (Arrival) opens | the workspace's creator portal |
| Coming back later | "Open your portal" on `/collection/`, and Creator sign in in the footer |

Inside the portal a seat opens four areas — Pathway, Studio, Sessions and My
Cohort — and weeks unlock on the cohort's shared calendar rather than on
individual completion. The page describes that handoff explicitly in its
"What a seat actually opens" section, so nobody has to guess where the room is,
and a member who loses their welcome letter still has a signposted way back in.

### `/api/cohort-status`

`netlify.toml` proxies it (status 200, not a redirect — a 301 would drop the
notify form's POST body) straight to the workspace, which owns the cycles, the
seats and the list. Same-origin, so it works regardless of CORS and the CDN can
cache it. `GET` returns the state; `POST {email, source}` joins the notify list
and returns a `message` the page renders verbatim.

**It is not live yet.** The workspace's cohort release is unmerged
(`createspace-workspace` PR #162), so the proxy currently reaches a 404. That
is survivable by design — the page shows its honest default — and the notify
form falls back to `/api/shop` (`kind: cohort`), which puts the same email in
the house inbox. Nobody who asks to be told is lost to the deployment gap. When
that PR merges, the live states light up with no change needed here.

Verify with `curl https://createspacebrand.com/api/cohort-status`: JSON means
connected, HTML or a 404 means the workspace hasn't shipped it yet.

### Stripe

The cohort's payment is the workspace's job and already exists there —
`cohort-checkout.mjs`, a Stripe Checkout session, a webhook that confirms the
seat and mints the portal invitation. **That is a different Stripe integration
from this site's.** The storefront's (`/shop/checkout/`, documented under
[The shop](#stripe--the-checkout)) shares no code, no session and no webhook
with it, and does not touch `/collection/` at all: a Collection seat is still
claimed in the workspace, and the two prices on that page are still prose.

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

The header is shared by every page: For creators, For brands and Shop sit in
the nav, and everything else is reached through the Menu — the three-line
button at the end of the nav whose panel lists the rest of the site. The panel
is a house component in `site.css`, so it renders identically on pages that
never load `shop.css`; the storefront adds only the cart control and the
announcement bar.

### Stripe — the checkout

`/shop/checkout/` is live, and **the whole of it happens on this site** — cart,
details, review, payment, confirmation, files. Nobody is redirected to
checkout.stripe.com and back.

The payment fields are Stripe's [Payment Element][pe]: an iframe served by
Stripe, mounted inside our own card on step 3. The card number is typed into
their frame, not our page, so **there is no card field anywhere in this repo**
and every claim the site makes about card data is literally true. What the
buyer sees is ours: `shop.js` reads the design tokens off `:root` at runtime
and hands them to Stripe's Appearance API, so the field is set in Raleway, in
seal and sage, at the house's radii — change a token in `site.css` and the
payment field follows. Card, Apple Pay, Google Pay and Link all appear there,
decided by what the Stripe account has switched on rather than hardcoded here.

[pe]: https://docs.stripe.com/payments/payment-element

> **The one thing this trades away.** Stripe's hosted Checkout applies
> promotion codes and Stripe Tax for you; a Payment Element flow doesn't, and
> faking coupons by lowering the amount would silently break redemption limits.
> Neither is wired, and the copy no longer claims either. If promotion codes
> become a launch requirement, the honest way back is Stripe's
> `ui_mode: 'custom'` Checkout Sessions, which keep Checkout's brain behind
> this same on-site UI.

**Stripe is the source of truth for price.** Nothing in this repo knows what
anything costs. `/api/catalog` reads the live prices and the site fills its
em-dashes in from that; `/api/checkout` resolves the amounts again, server-side,
from the product ids the cart sent. The browser never names a price and a price
it did name would be ignored — which is exactly why a cart kept in
`localStorage` is safe. Change a price in the Stripe dashboard and the site
follows within five minutes, with no deploy.

#### The endpoints

| Route | What it does |
|---|---|
| `GET /api/catalog` | Live shelf prices. Cached 5 minutes at the CDN; failures never cached. |
| `POST /api/checkout` | Validates the cart and the details, opens a PaymentIntent (or a subscription), returns its client secret. Rate-limited per IP. |
| `GET /api/order` | One order read back from Stripe — by Stripe's return parameters, or by the receipt's permanent token. Never cached. |
| `POST /api/stripe-webhook` | Stripe's callback — signature-verified, deduplicated, and the only thing that delivers. |
| `GET /api/download` | A file, to somebody holding a download token that names it. |
| `/api/products` | The stockroom, behind `ADMIN_TOKEN`. See [Digital delivery](#digital-delivery--the-stockroom). |

#### Setting it up

1. **Create the six products in Stripe**, one price each: `start-small`,
   `aesthetic-kit`, `creator-planner`, `content-system`, `starter-bundle`,
   `the-craft`. Make `the-craft` a **recurring** price — checkout switches
   itself to subscription mode when any line item recurs, and carries the
   one-time items onto the first invoice.
2. **Point the shelf at those prices**, either way round:
   - set each price's **lookup key** in Stripe to the id above — no env vars
     needed at all; or
   - set `STRIPE_PRICE_START_SMALL`, `STRIPE_PRICE_AESTHETIC_KIT`,
     `STRIPE_PRICE_CREATOR_PLANNER`, `STRIPE_PRICE_CONTENT_SYSTEM`,
     `STRIPE_PRICE_STARTER_BUNDLE`, `STRIPE_PRICE_THE_CRAFT` to `price_…` ids.
     An env var wins over a lookup key where both exist.
3. **Set `STRIPE_SECRET_KEY` and `STRIPE_PUBLISHABLE_KEY`** (`sk_test_…` and
   `pk_test_…` first — test mode is a complete, separate storefront and the
   right place to buy something end to end). Both are needed: the secret key
   opens the payment, the publishable key lets the field render. With only one
   of them the checkout stays honestly closed and says which is missing in the
   function log.
4. **Add the webhook** in Stripe → Developers → Webhooks, pointing at
   `https://createspacebrand.com/api/stripe-webhook`, subscribed to
   `payment_intent.succeeded`, `payment_intent.payment_failed` and
   `setup_intent.succeeded`. Put its signing secret in
   `STRIPE_WEBHOOK_SECRET`. **Nothing is delivered without this** — the
   webhook is what emails the files.
5. **Turn on Stripe's own email receipts** (Settings → Customer emails →
   *Successful payments*). The webhook writes the house's own email — what was
   bought, the download links, where to find them again — and leaves the tax
   receipt to Stripe.
6. **Put the files in the stockroom** — see the next section. A product with
   nothing uploaded still sells; the buyer is told plainly that the file is
   being finished rather than handed a link that 404s.

**Check it landed** at `/shop/admin/`, which opens with a *wiring* panel: both
Stripe keys, which mode they're in, how many of the six products resolved a
price, the webhook secret, and the mailbox — each either connected or with the
variable to set. It reports booleans and a mode, never a key or a fragment of
one, and it sits behind the same `ADMIN_TOKEN` as the rest of the stockroom.
Setting the shop up means pasting five values into a dashboard the site can't
see; this makes "did that take?" a page you look at rather than a purchase you
risk.

For the shelf specifically, `curl https://createspacebrand.com/api/catalog`:

| Response | Meaning |
|---|---|
| `{"ok":true,"resolved":6,…}` | Connected, whole shelf priced. |
| `{"ok":true,"resolved":4,…}` | Connected; two products have no price yet and show none. |
| `{"ok":false,"reason":"not-configured"}` | `STRIPE_SECRET_KEY` missing, or not scoped to Functions. |
| `{"ok":false,"reason":"no-prices"}` | The key works but no price resolved — wrong ids, or no lookup keys set. |

Until then the site is honest rather than broken: no price is shown anywhere,
"Add to cart" still works, and the pay button answers *"checkout isn't
connected yet — nothing was charged."* An unresolved price is never rendered as
zero and never as free.

#### The rules this checkout keeps

- **The browser is never trusted with money.** Ids in, amounts resolved
  server-side, `line_items` built from Stripe's own price objects. There is no
  code path that accepts an amount from a client.
- **The return page is not proof of payment.** `/shop/order/` shows only what
  `/api/order` reports; the webhook is what fulfils. A buyer who closes the tab
  still gets their order, and a refresh can't manufacture one.
- **Nothing is charged twice, and nothing is delivered twice.** Intent creation
  is idempotent per order reference; the order record carries a `delivered`
  flag, so however many times Stripe replays an event, one email goes out.
- **The order exists before the card is asked for.** `/api/checkout` writes it,
  keyed by the payment intent. The webhook then has somewhere to deliver to the
  instant the money lands, and the confirmation page has something to read even
  if the webhook is slow — both converge on the same download token rather than
  minting two.
- **A decline is said in place.** The buyer stays on step 3 with their cart, the
  message Stripe gave, and a button they can press again.
- **A delayed payment is neither a success nor a failure.** Methods that clear
  over days land on their own state on the confirmation page, and the buyer is
  emailed when the money actually moves.
- **A membership is a subscription, decided by Stripe.** A recurring price in
  the cart switches the flow; one-time items ride along on the first invoice. A
  trial confirms a SetupIntent instead — the card is filed, nothing is taken,
  and the page says "due today: nothing" rather than asking for $0.

#### Testing it without a Stripe account

`STRIPE_API_HOST` / `STRIPE_API_PORT` / `STRIPE_API_PROTOCOL` point the SDK at
[`stripe-mock`](https://github.com/stripe/stripe-mock) (or any stand-in) instead
of Stripe. Unset everywhere it's deployed; set it and no request reaches Stripe
at all. With a real test key, `4242 4242 4242 4242` and any future expiry buys
something for real in test mode.

## Digital delivery — the stockroom

Paying for a digital product delivers it. The webhook mints a download token,
writes to the buyer with a link per file, and the confirmation page shows the
same links as live buttons. Nothing is scheduled and nothing is manual.

**Where the files live.** Netlify Blobs, in three stores: `product-files` holds
the bytes, `product-shelf` holds one manifest per product, `orders` holds each
order twice — once under the payment intent that paid for it, once under the
download token that opens it (Blobs has no secondary index).

**Putting them there.** `/shop/admin/` — noindex, linked from nowhere, and shut
unless `ADMIN_TOKEN` is set to something at least 16 characters long. Paste the
key, drop a file on a product, and it is on sale with delivery attached. The key
is held in `sessionStorage`, so closing the tab closes the stockroom.

**Two ways to deliver**, per product, mixed freely:

| | For | Ceiling |
|---|---|---|
| An uploaded file | PDFs, presets, templates — anything a buyer should get from us | 40 MB per file on upload |
| An external `https://` link | a 1.2 GB preset pack, a Notion or Canva template, anything already hosted | none |

The upload ceiling is about the request body, not the download: files stream
back out. Anything larger belongs behind a link, and the stockroom says so when
you hit it. Links must be `https://` — they go in a receipt — and anything else
is dropped rather than saved.

**What the buyer gets, and when.** The token is minted only on a *succeeded*
payment. It names exactly what that order bought: a valid token for one order
can never reach another's files, and a product the order didn't buy is a 403.
Links don't expire (the site promises that), but each order carries a download
counter with a generous ceiling, so a link passed round a group chat is visible
in the log rather than invisible.

**A product with nothing uploaded still sells.** The buyer's email and the
confirmation page both say the file is being finished and their link will go
live — not a dead Download button — and the house inbox gets `FILES MISSING` in
the subject line so somebody knows to go and upload it. Upload it and the same
link starts working; no re-issue, no code change.

### Still to wire

- **Accounts.** `/shop/account/` reserves the address for launch day rather
  than pretending to create an account. The password is validated in the
  browser and never leaves it — `shop.js` strips it from the payload and the
  function has no field for it.
- ~~**Downloads**~~ Resolved: buying a product delivers it — see
  [Digital delivery](#digital-delivery--the-stockroom). What's left is the
  files themselves. Until they're uploaded, the confirmation and the receipt
  both say the product is being finished rather than showing a link that 404s.
- **Product photography.** Every product shot is a labelled striped frame, the
  same convention the rest of the site uses for imagery that doesn't exist yet.
- ~~**The three role addresses** on Contact~~ Resolved: the Contact page
  publishes no addresses anymore. The form is the single way in, and every
  form on the site delivers to `hello@createspacebrand.com` unless an env
  var says otherwise (see the environment table above).

## Caching — read before changing an asset

Everything under `/assets` (except fonts) is served `max-age=0,
must-revalidate`, so a returning visitor always revalidates and can never pair
new HTML with stale CSS. ETags make the usual answer a 304, so the cost is
negligible. Fonts are immutable under their filenames and cached for a year.

This matters because it went wrong twice. `/assets/*` was originally cached
hard for seven days, and the 2026-07-30 deploy served new HTML with week-old
CSS — the vignettes rendered as unstyled text and the mobile menu button
appeared raw. The first fix added `/assets/*.css` and `/assets/*.js`
revalidation rules — but Netlify header patterns only support a trailing
splat, so those rules silently never matched, stylesheets stayed on a day-long
cache, and the 2026-08-09 header rework repeated the failure on phones. Now
the whole of `/assets/*` revalidates.

The `?v=` query on the asset links is the second guard: **bump it in the same
change whenever a stylesheet or script changes.** A changed URL can never be
served from any cache, whatever the header rules happen to do.

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
- The privacy and terms pages are plain-words drafts in the house voice —
  worth a founder read-through before treating them as policy. The terms
  page exists (with the home page's "What createspace does" section) to
  satisfy Google's app-verification requirements: a home page that states
  the app's purpose, plus publicly linked privacy and terms pages.
- Home also displays the exact OAuth consent-screen app name —
  **createspace brand** — in its title, hero lede and "What createspace
  does" app row, because Google requires the configured app name to match
  a name visible on the home page. If the consent screen's name is ever
  changed (e.g. to "createspace · community + talent"), these mentions
  can be relaxed — but not removed in the same review cycle.

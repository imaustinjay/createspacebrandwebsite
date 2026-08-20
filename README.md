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
    deliver.mjs           one delivery, reachable from two doors
    receipt.mjs           the buyer's receipt — the house's own, not Stripe's
    storage.mjs           product files, their manifests, and orders (Blobs)
    admin-session.mjs     the portal's login — hash, mailed code, signed cookie
    analytics.mjs         the site's own visit counters (Blobs, day-sharded)
    searchconsole.mjs     real search terms, via a Google service account
    seo-audit.mjs         the site crawling and grading its own pages
    seo-playbook.mjs      findings + keyword map + the structural moves
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
    measure.mjs           POST /api/measure — one visit, counted; 204, no body
    admin-auth.mjs             /api/admin-auth — the portal's login
    insights.mjs          GET  /api/insights — traffic + search + audit + plan
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
    admin/                The portal — traffic, search terms, what to fix
    assets/site.css       tokens (verbatim from reference/PUBLIC_SITE_CONTEXT.md §3) + components
    assets/shop.css       storefront components, in those same tokens
    assets/shop.js        cart, drawer, live prices, countdown, FAQ, checkout, forms
    assets/admin.js       the stockroom's upload/list/link behaviour
    assets/insights.css   the portal's own components, in the house tokens
    assets/insights.js    the portal — sign in, read /api/insights, draw it
    assets/measure.js     the visit beacon, on every public page
    assets/zip.js         a ZIP writer, so a folder uploads as one download
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
| `STRIPE_WEBHOOK_SECRET` | The signing secret of the webhook endpoint at `/api/stripe-webhook`. Without it, payments still succeed but **nothing is delivered**: no files, no buyer email, no house notification. Holds **more than one**, comma- or space-separated — test and live are separate endpoints with separate secrets, and keeping both means a sandbox purchase still checks delivery after the switch to live. Also how you rotate one without a window where signatures fail. |
| `ADMIN_TOKEN` | Opens `/shop/admin/`, where the product files are uploaded. The one value nobody hands you — **/shop/admin/ has a "Make me one" button** that generates it in the browser. 16 characters minimum, 40 from the button. Unset, the stockroom is shut rather than open — see [Digital delivery](#digital-delivery--the-stockroom). |
| `STRIPE_PRICE_*` | Optional, one per product (`STRIPE_PRICE_START_SMALL`, …). Only needed if the prices don't carry lookup keys; an env var wins where both exist. |
| `STRIPE_AUTOMATIC_TAX` | Optional, `true` to turn on Stripe Tax. Off by default — it needs Stripe Tax configured on the account first, and it makes a billing address required at checkout. |
| `STRIPE_CRAFT_TRIAL_UNTIL` | Optional ISO date for the craft's subscription trial, so "nothing is charged before August 17" is enforced rather than promised. Ignored once it's in the past. |
| `PARTNERSHIPS_EMAIL` | Where brand enquiries land. Optional override — unset, they go to the house inbox, `hello@createspacebrand.com`. Server-side only — deliberately never printed in the client bundle, per the handoff, so it can't be scraped. |
| `SHOP_EMAIL` | Where the storefront's forms land (contact, careers and workshop alerts, internship applications, the Fall Drop list, account reservations, and the Collection Program notify list when the workspace endpoint can't be reached). Optional override — falls back to `PARTNERSHIPS_EMAIL`, then to `hello@createspacebrand.com`. Server-side only, same as above. |
| `MAIL_USER` / `MAIL_PASSWORD` | SMTP login for the sending mailbox (falls back to `TITAN_EMAIL` / `TITAN_PASSWORD`, same convention as the workspace's `shared/mailCore.mjs`). |
| `MAIL_SMTP_HOST` / `MAIL_SMTP_PORT` | Optional; default `smtp.titan.email` : `465`. |
| `MAIL_FROM_NAME` | Optional visible From name; defaults to the house name. |
| `SHOP_TIMEZONE` | Optional IANA zone (`America/Los_Angeles`) for the time printed on the receipt. Defaults to UTC — a guess would be worse than a label. |
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` | Powers the live "open now / between seasons" status on the doors — see the next section. Without them the status simply stays hidden; unknown is never shown as closed. |
| `ADMIN_PASSWORD` | The first half of the portal's login at `/admin/`. 24 or more random characters; under 12 and the door refuses to open at all rather than open weakly. Once you are inside, the portal will hand you an `ADMIN_PASSWORD_HASH` to replace it with — see [The portal](#the-portal--admin). |
| `ADMIN_PASSWORD_HASH` | Optional and better. `scrypt$<salt>$<hash>` — the env var stops being the secret and becomes a verifier for it. Wins over `ADMIN_PASSWORD` where both are set. |
| `ADMIN_SESSION_SECRET` | Signs the portal's session cookie. 24+ random characters. Unset, it is derived from `ADMIN_PASSWORD` + `ADMIN_TOKEN` — which works, and means changing the passphrase signs every session out. Set it explicitly only if you want sessions to survive that. |
| `ADMIN_EMAIL` | Where the portal's six-digit sign-in code is sent. Optional — falls back to `SHOP_EMAIL`, then `PARTNERSHIPS_EMAIL`, then the house inbox. Needs `MAIL_USER`/`MAIL_PASSWORD` set or there is no second step and the portal says so out loud. |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | The whole service-account key file, pasted in as one value. This is what makes the portal's Search tab show real keywords. Unset, that panel prints setup instructions rather than a number — see [Search Console](#search-console--the-keyword-panel). |
| `GSC_CLIENT_EMAIL` / `GSC_PRIVATE_KEY` | The same credentials in two pieces, if pasting the whole file is awkward. Netlify stores newlines as literal `\n`, which the signer handles. |
| `GSC_SITE_URL` | Which Search Console property to read — `sc-domain:createspacebrand.com` for a domain property, or the exact URL prefix if it was verified that way. Guessed from `URL` when unset. |

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
| `POST /api/stripe-webhook` | Stripe's callback — signature-verified, deduplicated, and the usual door onto delivery. |
| `GET /api/download` | A file, to somebody holding a download token that names it. |
| `/api/products` | The stockroom, behind `ADMIN_TOKEN`. See [Digital delivery](#digital-delivery--the-stockroom). |
| `POST /api/products?resend=` | Sends one order's receipt again. Same token, same door. |

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
   `setup_intent.succeeded`. Payload style **Snapshot** — the thin style sends
   a stub this webhook can't read. Put its signing secret in
   `STRIPE_WEBHOOK_SECRET`. **Nothing is delivered without this** — the
   webhook is what emails the files. Test and live need one endpoint each;
   `STRIPE_WEBHOOK_SECRET` holds both secrets at once, comma-separated.
5. **Turn Stripe's automatic receipt OFF** (Settings → Customer emails →
   uncheck *Successful payments*). The house sends its own — see [The
   receipt](#the-receipt) — and two receipts for one purchase is one too many.
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

#### Going live

Test and live are **two separate storefronts inside one Stripe account**. What
does not carry across, and has to be done again in live mode:

| | |
|---|---|
| The six products and their prices | Created in sandbox, they simply don't exist in live. Re-create them and set the same lookup keys. |
| The webhook endpoint | A separate one, with its own signing secret. |
| Email receipts | The *Successful payments* toggle is per-mode. |

What changes in Netlify: `STRIPE_SECRET_KEY` → `sk_live_…`,
`STRIPE_PUBLISHABLE_KEY` → `pk_live_…`, and the live signing secret **added
to** `STRIPE_WEBHOOK_SECRET` alongside the sandbox one. Everything else —
`ADMIN_TOKEN`, the mail variables, the uploaded files — is mode-agnostic and
stays exactly as it is. Then redeploy: Netlify hands variables to functions at
deploy time.

**The slip this guards against.** Swapping two keys by hand is where a live
secret ends up beside a leftover test publishable key. Stripe's two worlds
don't talk: an intent opened with one cannot be confirmed by the other, and the
failure lands on the buyer at the moment they press Pay, with a message about
intents rather than about the mix-up. So `/api/checkout` compares the pair and
**refuses to open a payment at all** when they disagree, and the wiring panel
says which is which. A shop that is honestly shut beats one that takes someone
to a payment field that cannot work.

**Checking the webhook without spending money.** Stripe's dashboard has a
*Send test event* button on each endpoint. It posts a real, correctly signed
event carrying a placeholder object, so it proves `STRIPE_WEBHOOK_SECRET`
exactly: a **200** means the signature verified, a **400** means the secret is
wrong. The webhook recognises the placeholder and answers
`{"reason":"test-event","signature":"ok"}` rather than treating it as a
stranger's payment. It proves the secret and the URL — not delivery, which
needs a real purchase or a sandbox key.

If Apple Pay doesn't appear on the live site, register the domain: Stripe →
Settings → Payments → Payment methods → Apple Pay → add `createspacebrand.com`.
Test mode doesn't need it, so this is the one difference that only shows up
after the switch.

#### Testing it without a Stripe account

`STRIPE_API_HOST` / `STRIPE_API_PORT` / `STRIPE_API_PROTOCOL` point the SDK at
[`stripe-mock`](https://github.com/stripe/stripe-mock) (or any stand-in) instead
of Stripe. Unset everywhere it's deployed; set it and no request reaches Stripe
at all. With a real test key, `4242 4242 4242 4242` and any future expiry buys
something for real in test mode.

## The receipt

Stripe sends a perfectly serviceable receipt of its own: a navy diagonal, a
summary table, a carbon-removal line. It is not ours, and its layout is not
reachable from code — the dashboard exposes a logo and two colours and nothing
else. So the house sends its own instead, and Stripe's is switched off. One
email per purchase, in ivory, seal and sage, with the wordmark at the top.

Which means it has to *be* a receipt rather than a thank-you note. It carries
who sold it, what it cost, when it was paid, the card that paid it
(`Visa •••• 4242`), a reference to quote, the refund terms, and a footnote
linking to Stripe's own hosted copy for anyone who wants the processor's
version. It also carries the download buttons — because the person hunting for
their receipt and the person hunting for their files are usually the same
person an hour apart.

`netlify/shared/receipt.mjs` builds it. Email HTML is 1999 HTML: tables for
layout, inline styles only, no webfont any client will reliably load. The
palette carries the brand instead, with Georgia standing in for Lora on the
wordmark — the closest thing to it that every mail client already has.

`SHOP_TIMEZONE` (an IANA name like `America/Los_Angeles`) sets the zone the
paid-at time is printed in. It defaults to UTC rather than guessing, because a
receipt with the wrong hour on it is a receipt somebody queries.

### Two doors onto delivery

The webhook is the right way for a receipt to get sent. It is also the piece
most likely to be misconfigured on a launch day — a wrong signing secret, an
endpoint pointing at the wrong URL, an unsubscribed event — and when it is, the
failure is invisible: the payment succeeds, the confirmation page works, the
files download, and the buyer simply never receives anything.

So `netlify/shared/deliver.mjs` is reachable from two places:

| Door | When |
|---|---|
| `/api/stripe-webhook` | Normally. It wins by a second or two. |
| `/api/order` | When a buyer opens their confirmation and the order is paid but still undelivered. |

`claimDelivery` in `storage.mjs` is the lease that lets exactly one of them do
the work — a claim rather than a lock, since Blobs has no compare-and-set. A
genuinely simultaneous pair could in principle both win; the window is
milliseconds and the cost is one duplicate receipt, which is a far smaller
failure than the one this exists to prevent. The claim expires after three
minutes so a crashed attempt can't wedge an order shut.

The house inbox copy names which door delivered it, so a webhook that has
quietly stopped working shows up as every order arriving "by order-page"
rather than as silence.

### The ledger, and sending one again

That signal used to live only in an email and a function log. `/shop/admin/`
now carries an **Orders** panel — the last 25 orders, newest first, each one
saying what happened to its receipt:

| It says | It means |
|---|---|
| Receipt sent · *by webhook* | Normal. The wiring is right. |
| Receipt sent · *by the confirmation page* | The webhook never arrived. The buyer got their email anyway — go and fix the endpoint. |
| Receipt sent · *by hand from here* | Somebody pressed the button below. |
| Paid — nothing sent | The payment is real and no mailbox was configured when it cleared. |
| Not sent yet | Paid moments ago, or never delivered at all. |

Every row has a **Send it again** button (`POST /api/products?resend=<intent>`,
behind the same `ADMIN_TOKEN`). It sends the real receipt — same template, same
download links, same reference — not an apology typed out by hand. A receipt
lost to a typo'd address, a spam folder, or a mailbox that wasn't configured
yet is one press to fix, and the header counts how many are outstanding so the
question doesn't have to be asked.

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

The gate has a **"Make me one"** button, because `ADMIN_TOKEN` is the only value
in the table that nobody hands you — Stripe's come from Stripe, the mailbox's
from the mailbox, and this one you invent. It draws 40 characters from the
browser's CSPRNG (rejection-sampled, so the alphabet isn't skewed) out of an
alphabet with no `0`/`O`/`1`/`l` and no punctuation, so it survives being read
off a screen and pasted into a shell. It is generated in the tab and sent
nowhere; it becomes real only once it is in Netlify.

Note the step that catches everyone: **Netlify hands environment variables to
functions at deploy time.** A variable added after the last build doesn't exist
until the next one — set it, then Deploys → Trigger deploy.

**Two ways to deliver**, per product, mixed freely:

| | For | Ceiling |
|---|---|---|
| An uploaded file | PDFs, presets, templates — anything a buyer should get from us | 40 MB per upload |
| An external `https://` link | a 1.2 GB preset pack, a Notion or Canva template, anything already hosted | none |

**A product that is a folder becomes one download.** Pick several files, or
*Choose a folder*, and the stockroom zips them **in the browser** before
uploading — one archive, one download button, folder structure intact. A buyer
handed twelve download buttons has been given a chore; this is the fix. One
file on its own is uploaded as itself rather than needlessly wrapped.

The zip writer is `public/assets/zip.js`, about a hundred lines, written by
hand for the same reason the fonts are self-hosted: no CDN, no build step, no
dependency. It is the original PKZIP format that every operating system opens
natively, with DEFLATE via the platform's own `CompressionStream` where that
exists and stored entries where it doesn't — or where compressing made the file
bigger, which is the usual outcome for the JPEGs, DNGs and PDFs it will mostly
be given. Entry names are stripped of leading slashes and `..` segments,
because they become paths on a stranger's disk.

Zipping happens on the machine that has the files, so the 40 MB ceiling applies
to the finished archive rather than to the folder — and the picker shows the
total before you commit to it. Anything larger still belongs behind a link.

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

## The free product

`the Creator Audit` costs nothing, and "nothing" is not a price of zero —
**Stripe will not open a PaymentIntent below 50¢**, so a cart holding only free
things must never reach Stripe at all.

It's marked in one place, `SHELF` in `netlify/shared/catalog.mjs`:

```js
'creator-audit': { …, free: true }
```

Everything follows from that flag:

| | What happens |
|---|---|
| `/api/catalog` | `resolvePrices` synthesises `{ amount: 0, display: 'Free' }` without asking Stripe. There is **no sixth Stripe product to create and no lookup key to set.** |
| `/api/checkout` | A cart where every item is free skips the Stripe guard entirely, writes the order, delivers it, and returns `{ free: true, orderUrl }` instead of a client secret. |
| The browser | Goes straight to the order page. No card field is ever mounted. |
| A **mixed** cart | Free + paid goes down the ordinary Stripe path; the free line simply contributes `0`. |
| The receipt | Says `Yours — Free`, not `Total paid — $0`, and the house copy calls it *"a lead, not a sale"*. |
| The wiring panel | **Doesn't count it.** It reads "0 of 6 priced" for an empty Stripe account, not "1 of 7" — a free product has no wiring to check. |

Because it never needs Stripe, it is the one thing on the shelf that still
works with **no Stripe keys set at all** — while a paid product in the same
state honestly refuses. There's a test for exactly that.

Its files go in the stockroom like everything else, and its order is a real
order: a download token, a permanent link, a row in the ledger, and a
**Send it again** button.

## Product art

Every product's photography is composed square, 1600×1600, and lives in the
repo — not in the stockroom. The stockroom is for the things people *buy*:
token-gated, served through a function, deliberately not public. Art is the
opposite, so it goes on the CDN with the rest of the assets.

    product-art/<shelf-id>/01-cover.png     the sources — NOT published
    product-art/<shelf-id>/02-….png         Netlify publishes `public/` only
    public/assets/products/<shelf-id>/      what the pages actually serve

**The sources are deliberately outside `public/`.** They are 7.2 MB of PNG and
no page ever wants them; keeping them in the repo means a crop can be redone
without asking for the files again.

**Renditions**, per source — 1.17 MB for the whole set:

| File | For |
|---|---|
| `<stem>-1200.webp` | the detail hero, on a retina screen |
| `<stem>-600.webp` | cards, thumbs, everything else |
| `<stem>-600.jpg` | the fallback in `<picture>`, for anything that can't read WebP |
| `<stem>-thumb.webp` / `.jpg` | covers only — a 300px crop for the small frames |

The `-thumb` cut exists because the art is a composed slide: a caption panel
on the left, the product on the right. At the 58px of a cart line the caption
is half the square and legible to nobody, so those frames show the product
itself. Anything larger keeps the whole composition.

**Regenerating them.** There is no ImageMagick in this repo and no build step —
but Playwright's Chromium decodes PNG, scales on a canvas and encodes WebP and
JPEG, so a browser is the pipeline. The script lives in the session scratchpad
rather than the repo, because it runs once per art drop rather than per deploy.
Re-run it after replacing anything in `product-art/`, then bump the fingerprints.

**A product with no art is a supported state**, not a bug. `the craft` has none,
and its frames keep the striped placeholder — the same "not shot yet" ground
that sits under every image while it loads. Nothing renders as a broken picture.

**Prices are baked into the covers** (`THE STARTER · $19`) and into
`starter-bundle/02-value.png` in full. The storefront reads its prices from
Stripe, so these are a second source of truth that cannot be edited from here:
**re-export the art whenever a price changes in Stripe**, or the card and the
line beneath it will disagree.

## The portal — `/admin/`

Traffic, search terms, and what to do about both — on one page, behind a login
only the owner can pass. Nothing links to it and it is `noindex` in both the
page and the response header.

### The login

Three parts, because "one secret typed anywhere, forever" is the shape of an
upload endpoint's guard rather than a login, and this page holds more than the
stockroom does.

1. **A passphrase**, checked against `ADMIN_PASSWORD` or — better —
   `ADMIN_PASSWORD_HASH`, so the environment variable is a verifier rather
   than the secret itself. Compared in constant time either way.
2. **A six-digit code**, mailed to `ADMIN_EMAIL` through the house mailer.
   Good for ten minutes, spendable once, five wrong tries and it dies. This
   is the part that makes the login *verified*: knowing the passphrase is not
   enough without holding the mailbox.
3. **A signed session cookie** — HMAC over our own payload, `HttpOnly` so no
   script on the page can read it, `SameSite=Strict` so it is never attached
   to a request another site started, `Secure` everywhere but localhost.
   Twelve hours.

Ten failed attempts from one IP in an hour and that IP is locked out. The door
is **shut, not open**, whenever it is not fully configured: an unset
`ADMIN_PASSWORD` answers 503 with the variable's name, never a blank page that
somebody might get past.

**No mailbox is a supported state, and an honest one.** With `MAIL_USER` /
`MAIL_PASSWORD` unset there is nowhere to send a code, so a correct passphrase
signs you in on one factor and the page says exactly that at the top. Locking
the owner out of their own site over an unset SMTP variable would be the worse
failure.

**Setting it up.** Put 24 random characters in `ADMIN_PASSWORD`, 24 more in
`ADMIN_SESSION_SECRET`, redeploy, and sign in. To upgrade to a stored hash,
`POST /api/admin-auth` with `{ "step": "hash", "passphrase": "…" }` from inside
a signed-in session — it returns the `scrypt$…` line to paste into
`ADMIN_PASSWORD_HASH`. That endpoint refuses without a session on purpose: an
open hashing endpoint is an oracle for testing guesses without tripping the
lockout.

### Traffic — measured here, kept here

`/assets/measure.js` is on every public page and sends two small messages per
view to `/api/measure`: the path, the referrer, whether it began the visit,
then how long the page was open and how far down it was scrolled. The endpoint
answers **204 with no body, always** — a measurement endpoint that answers
questions is one being used for something else.

Why first-party rather than a tag:

- **No cookie banner**, because there is no cookie and no durable identifier.
- **Not blockable into silence** — the beacon is same-origin and looks like
  every other request the site makes.
- **The numbers stay ours** — no account, no sampling, no retention policy
  written by somebody else.

**People are counted without being identified.** The IP and user agent are
hashed with the day's date down to eleven characters; there is no table that
reverses it, and tomorrow the same visitor is a different string on purpose.
The IP itself is never stored beside anything else about the visit. That
answers "how many people" and refuses to answer "which people", which is the
only version of the number worth keeping. It is written up plainly on
[`/privacy/`](public/privacy/index.html) — **keep those two in step.**

**Not counted:** anything whose user agent looks automated, any request whose
`Origin` is not this site, `localhost`, `/admin/`, `/shop/admin/`, and any
browser holding `cs.measure.off` in localStorage — which the portal sets on
itself the first time you open it, so reading your numbers never inflates them.
There is a per-IP ceiling of 200 views an hour.

**Stored day-sharded in Blobs** (`day/<date>/<0-7>`). Blobs has no atomic
increment, so two visits in the same instant would each read, add one, and
write back — losing one. Eight shards make that eight times rarer and a read
simply sums them. Undercounting by a hair beats holding a lock on every
pageview, and the alternative to both is a third party.

**A range is visitors-per-day added up**, not a distinct count across days —
the salt rotates daily, so the union genuinely cannot be recovered. Every tool
reports it that way unless it keeps a durable identifier, and keeping one is
the thing this deliberately does not do.

### Search Console — the keyword panel

Impressions, clicks and average position are measurements of Google's index.
Nothing on this side can stand in for them, so **when the connection is not
configured the panel prints setup steps rather than a number.** A dashboard
that guesses at its search data is worse than one that admits it has none,
because a guess gets acted on.

The connection is a Google service account with read access to the property —
no OAuth dance, no refresh token to babysit. A signed assertion goes out, an
access token comes back, and it is cached in the instance until it expires.

1. Google Cloud Console → new project → enable the **Google Search Console
   API**.
2. Credentials → **Service account** (no roles — it needs none) → Keys → JSON.
3. **Search Console → the property → Settings → Users and permissions → add
   the service account's email.** This is the step everybody misses; without
   it the key works and every read returns 403. The portal names that case
   specifically when it happens.
4. Paste the key file into `GOOGLE_SERVICE_ACCOUNT_JSON`, set `GSC_SITE_URL`,
   redeploy.

Every window ends **three days ago**, because Search Console's own data lags
by that much and asking for yesterday returns nothing — which reads as "we
lost all our traffic" on a chart.

### Suggestions — findings, then strategy

Two kinds of advice, kept visibly apart because the reader has to know which
is which.

**Findings are computed.** `seo-audit.mjs` fetches the pages `sitemap.xml`
lists, exactly as a crawler would receive them, and grades each on title and
description length, canonical, heading structure, word count, alt text, image
dimensions, structured data, share tags and internal links. Duplicate titles
and descriptions are found across pages, which no single-page check can see.
Every finding names the pages it applies to and disappears when they are
fixed. The crawl is cached an hour; **Refresh** re-runs it.

The score is this site grading itself against those checks — 100 minus 18 per
critical, 8 per warning, 3 per note. It is not a number from Google, and the
page says so where it is shown.

`noindex` pages are crawled to confirm they still say `noindex` and then left
alone. A missing description on a page nobody should find is correct, not a
fault, and flagging it would train the reader to ignore the list.

**Strategy is written.** The keyword map — nine clusters grouped by the job
the searcher is doing, each naming the page that should win it — and the
structural moves are editorial judgement about this business, labelled as
such. **No search volumes or difficulty scores appear anywhere**, because
nothing here can measure one. Where Search Console is connected, terms in the
map that already rank are marked with their live position; where it is not,
they are simply terms.

The largest item on that list is that there is nowhere on this site to answer
a question. Every page sells something, and almost all search volume in this
category is people asking how to do something — see the `journal` entry in
`seo-playbook.mjs`.

### Reading it locally

`netlify dev` is required — the portal is four serverless functions and a
static server serves none of them. `ADMIN_PASSWORD` and `ADMIN_SESSION_SECRET`
in `.env` are enough to get in; Search Console and the mailer will each say
they are not connected, which is the state they are meant to show.

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

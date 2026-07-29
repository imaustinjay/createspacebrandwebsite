# createspacebrand.com — public marketing site

The public website for **createspace · community + talent**, ported from the
Claude Design handoff (`Createspace_brand_website_design.zip`). Six real routes,
one shared stylesheet, two serverless functions. The workspace app
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
  public/                 everything served, exactly as-is — no build step
    index.html            Home
    creators/index.html   For creators (Community division)
    talent/index.html     Talent (representation)
    brands/index.html     For brands + enquiry form (#enquire)
    platform/index.html   The platform
    about/index.html      About + founder letter
    privacy/index.html    Privacy — what the site holds, plainly
    assets/site.css       tokens (verbatim from reference/PUBLIC_SITE_CONTEXT.md §3) + components
    assets/enquiry.js     form submit → /api/enquiry → confirmation state
    assets/seasons.js     fills the door-status slots from /api/seasons
    assets/reveal.js      below-fold sections settle in (house motion verb)
    assets/motion.js      word-staggered headlines + the rotating proof line
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
| `MAIL_USER` / `MAIL_PASSWORD` | SMTP login for the sending mailbox (falls back to `TITAN_EMAIL` / `TITAN_PASSWORD`, same convention as the workspace's `shared/mailCore.mjs`). |
| `MAIL_SMTP_HOST` / `MAIL_SMTP_PORT` | Optional; default `smtp.titan.email` : `465`. |
| `MAIL_FROM_NAME` | Optional visible From name; defaults to the house name. |
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` | Powers the live "open now / between seasons" status on the doors — see the next section. Without them the status simply stays hidden; unknown is never shown as closed. |

Every variable must be scoped so **Functions** can read it (Netlify's "All
scopes" default is fine). A variable scoped to Builds only is invisible at
runtime, which looks exactly like a missing variable.

Until the variables are set, the form returns a calm "the enquiry desk isn't
connected yet" message — nothing breaks, nothing is silently dropped.

Abuse guards on the function: a honeypot field, a minimum-fill-time check
(instant submissions are quietly discarded), and a per-IP limit of 5 an hour
(durable via Netlify Blobs, in-memory fallback locally).

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

## Local preview

```bash
npx -y serve public          # pages only
npx -y netlify-cli dev       # pages + the serverless functions
```

## Still open (from the handoff, on purpose)

- **Imagery** — every frame is a labelled striped placeholder: campaign
  stills, a media kit screenshot, a deal room screenshot, an invoice/signing
  screenshot, and the founder portrait on About.
- **No roster grid**, by decision — only alongside real names and portraits.
- Commission percentages and the 90/10 split stay qualitative, by decision.
- The privacy page is a plain-words draft in the house voice — worth a
  founder read-through before treating it as policy.

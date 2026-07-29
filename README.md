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

The workspace keeps its own repo, Netlify site and env; the two share nothing.
No Supabase database is needed for the marketing site — the enquiry form goes
to email, and every application flow lives on createspacebrand.online.

## Environment variables (the enquiry form)

| Variable | What it is |
|---|---|
| `PARTNERSHIPS_EMAIL` | Where enquiries land (e.g. the partnerships@ mailbox). Server-side only — deliberately never printed in the client bundle, per the handoff, so it can't be scraped. |
| `MAIL_USER` / `MAIL_PASSWORD` | SMTP login for the sending mailbox (falls back to `TITAN_EMAIL` / `TITAN_PASSWORD`, same convention as the workspace's `shared/mailCore.mjs`). |
| `MAIL_SMTP_HOST` / `MAIL_SMTP_PORT` | Optional; default `smtp.titan.email` : `465`. |
| `MAIL_FROM_NAME` | Optional visible From name; defaults to the house name. |
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` | Optional — powers the live "open now / between seasons" status on the doors. Use the same **public** pair the workspace ships (`VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` values); RLS only exposes open casting cycles to anon. Without them the status simply stays hidden — unknown is never shown as closed. |

Until the variables are set, the form returns a calm "the enquiry desk isn't
connected yet" message — nothing breaks, nothing is silently dropped.

Abuse guards on the function: a honeypot field, a minimum-fill-time check
(instant submissions are quietly discarded), and a per-IP limit of 5 an hour
(durable via Netlify Blobs, in-memory fallback locally).

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

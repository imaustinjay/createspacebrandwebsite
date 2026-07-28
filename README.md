# createspacebrand.com — public marketing site

The public website for **createspace · community + talent**, ported from the
Claude Design handoff (`Createspace_brand_website_design.zip`). Six real routes,
one shared stylesheet, one serverless function. The workspace app
(createspacebrand.online) lives in the repo root and deploys separately —
nothing in here touches it.

## Structure

```
site/
  netlify.toml            deploy config for THIS site (base directory = site)
  package.json            deps for the enquiry function only
  netlify/functions/
    enquiry.mjs           brand enquiry → partnerships mailbox (SMTP)
  public/                 everything served, exactly as-is — no build step
    index.html            Home
    creators/index.html   For creators (Community division)
    talent/index.html     Talent (representation)
    brands/index.html     For brands + enquiry form (#enquire)
    platform/index.html   The platform
    about/index.html      About + founder letter
    assets/site.css       tokens (verbatim from reference/PUBLIC_SITE_CONTEXT.md §3) + components
    assets/enquiry.js     form submit → /api/enquiry → confirmation state
    404.html · robots.txt · sitemap.xml · favicon.svg
```

Each page carries its own `<title>` (from the design's `TITLES` map), meta
description, canonical URL and OG tags — the SPA page-switcher from the design
became real routes, per the handoff README.

## Connecting it (Netlify + GitHub)

1. Netlify → **Add new site** → **Import an existing project** → pick this
   same GitHub repo.
2. Set **Base directory** to `site`. Everything else (publish dir, functions)
   is read from `site/netlify.toml`.
3. Point the custom domain **createspacebrand.com** at the new site.
4. Set the environment variables below, then deploy.

The workspace site keeps its own Netlify site + env; the two share nothing but
the repo. No Supabase is needed for the marketing site — the enquiry form goes
to email, and every application flow lives on createspacebrand.online.

## Environment variables (the enquiry form)

| Variable | What it is |
|---|---|
| `PARTNERSHIPS_EMAIL` | Where enquiries land (e.g. the partnerships@ mailbox). Server-side only — deliberately never printed in the client bundle, per the handoff, so it can't be scraped. |
| `MAIL_USER` / `MAIL_PASSWORD` | SMTP login for the sending mailbox (falls back to `TITAN_EMAIL` / `TITAN_PASSWORD`, same convention as the workspace's `shared/mailCore.mjs`). |
| `MAIL_SMTP_HOST` / `MAIL_SMTP_PORT` | Optional; default `smtp.titan.email` : `465`. |
| `MAIL_FROM_NAME` | Optional visible From name; defaults to the house name. |

Until the variables are set, the form returns a calm "the enquiry desk isn't
connected yet" message — nothing breaks, nothing is silently dropped.

Abuse guards on the function: a honeypot field, a minimum-fill-time check
(instant submissions are quietly discarded), and a per-IP limit of 5 an hour
(durable via Netlify Blobs, in-memory fallback locally).

## Local preview

```bash
cd site && npx -y serve public         # pages only
cd site && npx -y netlify-cli dev      # pages + the enquiry function
```

## Still open (from the handoff, on purpose)

- **Imagery** — every frame is a labelled striped placeholder: campaign
  stills, a media kit screenshot, a deal room screenshot, an invoice/signing
  screenshot, and the founder portrait on About.
- **No roster grid**, by decision — only alongside real names and portraits.
- **No og:image yet** — worth adding once real imagery exists.
- Commission percentages and the 90/10 split stay qualitative, by decision.

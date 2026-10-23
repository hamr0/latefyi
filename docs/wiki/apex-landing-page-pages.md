---
title: Apex landing page via Cloudflare Pages
theme: apex-landing-page-pages
sources:
  - docs/archive/cloudflare-setup.md
---

# Apex landing page via Cloudflare Pages

Serving the late.fyi apex landing page from `web/index.html` via Cloudflare Pages.

## Step 18 — Apex landing page via Cloudflare Pages

The apex `late.fyi` serves a static one-pager from `web/index.html` (docs/archive/cloudflare-setup.md:562-564).

### Create the Pages project

1. Cloudflare → **Workers & Pages** → **Create application** → **Pages** → **Connect to Git** → repo `hamr0/latefyi` (docs/archive/cloudflare-setup.md:566-566)
2. Build settings (docs/archive/cloudflare-setup.md:567-576):

| Field | Value |
|---|---|
| Project name | `latefyi` |
| Production branch | `main` |
| Framework preset | None |
| Build command | *(empty)* |
| Build output directory | `web` |
| Root directory | *(empty)* |

3. Save and Deploy. The `<project>.pages.dev` URL serves immediately (docs/archive/cloudflare-setup.md:578-578).
4. **Custom domains** → **Set up a custom domain** → `late.fyi`. CF auto-creates a CNAME-flattened apex record (DNS already on the same zone) (docs/archive/cloudflare-setup.md:579-579).

### Apex DNS fallback

If apex DNS doesn't resolve after the custom-domain step, manually add a CNAME at `@` pointing to `<project>.<account>.workers.dev`, **proxied** (orange cloud). The "auto-add" step occasionally skips when other DNS rows for the apex already exist (docs/archive/cloudflare-setup.md:581-581).

### Verify

```sh
dig +short late.fyi @1.1.1.1   # should return CF anycast (188.114.x.x)
curl -sI https://late.fyi | head -1   # HTTP/2 200
```

(docs/archive/cloudflare-setup.md:583-587)

### Deploys

Subsequent pushes to `main` auto-deploy the page. Branch pushes get preview URLs (`<branch>.latefyi.pages.dev`) (docs/archive/cloudflare-setup.md:589-589).

### Two Workers, often confused

- `latefyi-ingest` — Email Worker (this guide steps 13–15). No HTTP route.
- `latefyi` — Pages-style Worker (this step). Has custom domain `late.fyi`.

(docs/archive/cloudflare-setup.md:591-593)

Don't add the email handler to the Pages Worker, and don't add an HTTP route to the email Worker. They show up in the same dashboard (docs/archive/cloudflare-setup.md:595-595).

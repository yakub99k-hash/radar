# radar

Yaqubu Radar: scan a YouTube channel, detect sponsored brands, then find a real
partnership contact for each brand.

- `index.html` — the whole frontend (GitHub Pages, `radar.yaqubu.com`). It reads
  sponsor links from video descriptions, then calls the Cloudflare Worker at
  `CONTACT_API` to look for an email printed on the brand's own website.
- `server/` — Node.js fallback service. When the website shows **"Not found on
  website"**, the frontend calls `GET/POST /api/brand-contact` with the provider
  the visitor picked (`x-provider: hunter|prospeo`) and **their own API key**
  (`x-api-key`). Nothing runs on the site owner's credits: without a user key the
  API answers `400` with *"Please add your own API key first."*
  - **Hunter** — domain search + email finder + verifier.
  - **Prospeo** — search-person (who works there) + enrich-person (verified email).
  - **Gemini** reads the page text for hidden addresses first (free compared to
    provider credits) and picks the best contact once the provider answers.
  - **Apollo** is optional and off by default (`CONTACT_USE_APOLLO=true`), because
    it would spend the owner's own Apollo key.

```
frontend ──► CONTACT_API (worker, website scrape) ──► "best" printed email
        └──► CONTACT_FALLBACK_API (server/)
               └► Gemini text scan ─► Hunter (user key) or Prospeo (user key)
```

## Run the contact finder

```bash
cp .env.example .env          # only GEMINI_API_KEY is worth setting
cd server && npm install && npm start

# every lookup needs a provider and the visitor's own key
curl -H "x-provider: hunter" -H "x-api-key: YOUR_HUNTER_KEY" \
  "http://localhost:8787/api/brand-contact?domain=brand.com&brand=Brand"
curl -H "x-provider: prospeo" -H "x-api-key: YOUR_PROSPEO_KEY" \
  "http://localhost:8787/api/brand-contact?domain=brand.com&brand=Brand"
```

Then set the service URL in `index.html`:

```js
var CONTACT_FALLBACK_API="https://radar-backend-kuw7.onrender.com/api/brand-contact";
```

Full request/response contract, configuration and deployment notes:
[`server/README.md`](server/README.md).

## Test

```bash
cd server && npm test
```

Secrets live only in `.env` (git ignored) and in the hosting provider's
environment variables; never in `index.html` or the repo.

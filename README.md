# radar

Yaqubu Radar: scan a YouTube channel, detect sponsored brands, then find a real
partnership contact for each brand.

- `index.html` — the whole frontend (GitHub Pages, `radar.yaqubu.com`). It reads
  sponsor links from video descriptions, then calls the Cloudflare Worker at
  `CONTACT_API` to look for an email printed on the brand's own website.
- `server/` — Node.js fallback service. When the website shows **"Not found on
  website"**, the frontend calls `GET/POST /api/brand-contact`, which uses
  **Apollo.io + Hunter.io** to find a named contact, verify the email and return
  clean JSON.

```
frontend ──► CONTACT_API (worker, website scrape) ──► "best" printed email
        └──► CONTACT_FALLBACK_API (server/, Apollo + Hunter) ──► named contact
```

## Run the contact finder

```bash
cp .env.example .env          # add APOLLO_API_KEY and HUNTER_API_KEY
cd server && npm install && npm start
curl "http://localhost:8787/api/brand-contact?domain=brand.com&brand=Brand"
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

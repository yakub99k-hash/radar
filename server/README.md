# Radar contact finder (Apollo.io + Hunter.io)

Small Node.js service that turns a brand domain into a **named, verified contact**
when the brand's own website shows no email address.

It plugs in behind the existing `radar-contacts` Cloudflare Worker: the worker
scrapes the website, this service is the automatic fallback.

```
frontend (index.html)
   │  GET /api/brand-contact?domain=brand.com&brand=Brand
   ▼
1. Apollo  POST /mixed_people/api_search      (0 credits)  titles: Influencer Marketing,
                                                            Partnerships, Creator Relations,
                                                            Social Media Manager
2. rank    title scoring -> best person first
3. Apollo  POST /people/match                 (~1 credit)  full name + LinkedIn URL
4. Hunter  GET  /v2/email-finder              (1 credit)   email for that person
5. Hunter  GET  /v2/email-verifier            (1 credit)   status must be valid/deliverable
6. filter  info@, press@, support@ ... -> marked as "fallback", never returned as a person
7. JSON    { contact_name, title, email, email_status, linkedin_url, found, ... }
```

## Why two Apollo calls?

Apollo's people **search** endpoint is anonymised on purpose: it returns
`first_name` plus `last_name_obfuscated` (`Do***e`) and **no** LinkedIn URL. The
`people/match` endpoint returns the real `name` and `linkedin_url`. The LinkedIn
handle is also the most accurate input for Hunter, so it is fetched once for the
best candidate only (cost control).

## API

`GET` or `POST /api/brand-contact`

| input | where | notes |
| --- | --- | --- |
| `domain` | query or JSON body | required, `https://www.brand.com/x` is cleaned to `brand.com` |
| `brand` | query or JSON body | optional, used to disambiguate when Apollo does not know the domain |

Success:

```json
{
  "contact_name": "Jane Doe",
  "title": "Influencer Marketing Manager",
  "email": "jane@brand.com",
  "email_status": "valid",
  "linkedin_url": "https://www.linkedin.com/in/jane-doe-4a7c21",
  "is_fallback": false,
  "found": true,
  "reason": null,
  "message": "Jane Doe (Influencer Marketing Manager) found via Apollo + Hunter.",
  "meta": { "domain": "brand.com", "candidates": 6, "hunter_score": 96, "elapsed_ms": 1840 }
}
```

Nothing usable found (always HTTP 200, so the UI can show a reason):

```json
{
  "contact_name": null,
  "title": null,
  "email": null,
  "email_status": null,
  "linkedin_url": null,
  "is_fallback": false,
  "found": false,
  "reason": "NO_PERSON_FOUND",
  "message": "No influencer or partnership contact was found at brand.com.",
  "meta": { "domain": "brand.com", "candidates": 0, "elapsed_ms": 420 }
}
```

Generic mailbox found (`info@`, `press@`, `support@`, ...). It is returned **and
flagged**, so the UI can offer it as a last resort:

```json
{
  "contact_name": "Jane Doe",
  "title": "Influencer Marketing Manager",
  "email": "press@brand.com",
  "email_status": "valid",
  "linkedin_url": "https://www.linkedin.com/in/jane-doe-4a7c21",
  "is_fallback": true,
  "found": false,
  "reason": "GENERIC_EMAIL",
  "message": "Only the generic mailbox press@brand.com was found, so it is marked as a fallback."
}
```

`reason` values: `INVALID_DOMAIN`, `NO_PERSON_FOUND`, `NO_EMAIL_FOUND`,
`EMAIL_UNVERIFIED`, `GENERIC_EMAIL`, `UPSTREAM_ERROR`.

Errors use normal HTTP codes with `{ "error": "...", "code": "..." }`
(400 missing/invalid domain, 401 bad login, 429 upstream rate limit, 5xx).

Health check: `GET /healthz` -> `{ ok, apollo, hunter, auth, uptime_s }`

## Setup

```bash
cd server
npm install
cp ../.env.example ../.env      # then fill APOLLO_API_KEY and HUNTER_API_KEY
npm start                       # http://localhost:8787
```

The service reads `<repo>/.env` and then `server/.env`; real environment
variables win over both. `npm run dev` restarts on file changes.

Then put the deployed URL into `index.html`:

```js
var CONTACT_FALLBACK_API="https://your-service.example.com";
```

Leave it empty and the frontend simply skips the automatic step.

## Configuration

| variable | default | meaning |
| --- | --- | --- |
| `APOLLO_API_KEY` | – | required |
| `HUNTER_API_KEY` | – | required |
| `PORT` | `8787` | HTTP port |
| `ALLOWED_ORIGINS` | empty (`*`) | comma separated browser origins |
| `FIREBASE_WEB_API_KEY` | empty | the `apiKey` from `FIREBASE_CONFIG` in `index.html` |
| `REQUIRE_AUTH` | `false` | require `Authorization: Bearer <firebase id token>` |
| `CONTACT_TITLES` | Influencer Marketing, Partnerships, Creator Relations, Social Media Manager | Apollo `person_titles` |
| `HUNTER_ACCEPT_STATUSES` | `valid,deliverable` | verifier outcomes that count as verified |
| `ALLOW_ACCEPT_ALL` | `false` | accept catch-all domains (`accept_all` / `risky`) |
| `REQUIRE_BRAND_DOMAIN` | `true` | reject gmail.com etc. |
| `MAX_ENRICHED_CANDIDATES` | `2` | Apollo `people/match` calls per brand |
| `MAX_EMAILS_TO_VERIFY` | `2` | Hunter verifier calls per brand |
| `CACHE_TTL_SECONDS` | `21600` | cached successful lookups (0 disables) |
| `CACHE_NEGATIVE_TTL_SECONDS` | `1800` | cached "nothing found" answers |
| `MAX_CONCURRENT_LOOKUPS` | `3` | parallel brand lookups |
| `HTTP_TIMEOUT_MS` / `HTTP_RETRIES` | `15000` / `2` | outbound HTTP policy |
| `HUNTER_POLL_ATTEMPTS` / `HUNTER_POLL_DELAY_MS` | `3` / `1500` | retries while Hunter verifies (HTTP 202) |
| `MIN_TITLE_SCORE` | `25` | drop irrelevant titles before spending credits |

## Credit safety

- results (including "nothing found") are cached for `CACHE_TTL_SECONDS`;
- identical concurrent requests share one run (`inflight` map);
- only the top `MAX_ENRICHED_CANDIDATES` people are enriched, best title first;
- off-domain and generic addresses are filtered before verification where possible;
- a semaphore caps parallel brand lookups, so "Find contacts for all" cannot
  fire 40 pipelines at once.

## Deploy

Any Node 20+ host works (Render, Fly.io, Railway, a VPS...). GitHub Pages only
serves static files, so the frontend stays there and this service runs elsewhere.

```bash
cd server && npm ci --omit=dev && node src/index.js
```

Set the environment variables in the host's dashboard (never commit `.env`).
For production, set `REQUIRE_AUTH=true` + `FIREBASE_WEB_API_KEY` and an explicit
`ALLOWED_ORIGINS` list, otherwise anyone who finds the URL can spend your
Apollo/Hunter credits.

## Tests

```bash
cd server && npm test     # node:test, no network, no credits
```

Covers domain cleaning, title ranking, generic mailbox detection, the Apollo and
Hunter clients (mocked), every pipeline branch, the HTTP layer (retries,
timeouts, CORS, auth) and a full end-to-end run against a local fake upstream.

(booleans only, never the keys).

# Radar contact finder (Apollo.io + Hunter.io)

Small Node.js service that turns a brand domain into a **named, verified contact**
when the brand's own website shows no email address.

It plugs in behind the existing `radar-contacts` Cloudflare Worker: the worker
scrapes the website, this service is the automatic fallback.

```
frontend (index.html)
   │  POST /api/brand-contact  { domain, brand, pageText? }
   │  headers: Authorization (Firebase), x-hunter-api-key (optional, the user's key)
   ▼
0. Gemini  reads the page text                (few tokens)  -> an email here costs
           (sent by the browser, or fetched by the service)     nothing else
A. Apollo path (used when Apollo answers)
   1. Apollo  POST /mixed_people/api_search      (0 credits)  titles: Influencer Marketing,
                                                             Partnerships, Creator Relations,
                                                             Social Media Manager
   2. rank    title scoring -> best person first
   3. Apollo  POST /people/match                 (~1 credit)  full name + LinkedIn URL
   4. Hunter  GET  /v2/email-finder              (1 credit)   email for that person
   5. Hunter  GET  /v2/email-verifier            (1 credit)   status must be valid/deliverable

B. Hunter path (Apollo missing, placeholder key, outage, or knows nobody)
   1. Hunter  GET  /v2/domain-search             (1 credit)   every address Hunter knows
   2. rank    same title scoring -> named contacts before info@ / press@
   3. Gemini  picks the influencer/partnership owner out of the shortlist (few tokens)
   4. verify  reuse the status domain search returned, else /v2/email-verifier

6. filter  off-domain addresses, and info@, press@, support@ ... -> marked as "fallback",
           never returned as a person
7. JSON    { contact_name, title, email, email_status, linkedin_url, found, ... }
```

Both paths return the same JSON shape, so the frontend needs no extra handling.
`meta.strategy` tells you which one answered (`apollo+hunter` or
`hunter-domain-search`); when Apollo failed, `meta.apollo_error` carries the reason.

## Hunter-only mode

A missing or rejected `APOLLO_API_KEY` is **not** an error: the pipeline switches
to Hunter's domain search, which returns people, job titles, LinkedIn profiles and
(often) a verification status in one call. Job titles are ranked with the same
rules as Apollo, addresses off the brand domain are dropped, and only the best
few are verified - and only when domain search did not already report a status.
That keeps the credit cost at roughly one domain search plus one verification.

A real 503 is only returned when *neither* provider can answer (for example
`HUNTER_API_KEY` is missing too).

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
| `pageText` | JSON body | optional, the page text the browser already scraped for the Gemini step (max 40 kB) |
| `x-hunter-api-key` | header | optional, spend the caller's own Hunter credits for this request only |

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
`EMAIL_UNVERIFIED`, `GENERIC_EMAIL`, `UPSTREAM_ERROR`, `HUNTER_CREDIT_LIMIT`.
`HUNTER_CREDIT_LIMIT` is the one the UI shows as
**"API Limit Reached - Please add your own Hunter key"** (Hunter answered 402/429).

Errors use normal HTTP codes with `{ "error": "...", "code": "..." }`
(400 missing/invalid domain, 401 bad login, 429 upstream rate limit, 5xx).

Health check: `GET /healthz` -> `{ ok, apollo, hunter, gemini, auth, uptime_s }`

## Bring your own Hunter key

The frontend stores a visitor's Hunter key in `localStorage` and sends it as
`x-hunter-api-key`. The service builds a Hunter client for that key and uses it
for **that request only**, so a user never spends the owner's credits and the
owner's key is never exposed. No header (or an empty one) falls back to
`HUNTER_API_KEY`. Set `ALLOW_USER_HUNTER_KEY=false` to ignore the header and
always bill the owner. Keys are never logged or put in URLs.

## The Gemini steps

Both are optional; configure `GEMINI_API_KEY` to switch them on.

1. **Page text scan** (before any Hunter call). Gemini reads the text of the
   brand's pages and returns addresses the regex-based scraper misses -
   `press [at] brand [dot] com`, addresses only in JSON-LD, in image alt text,
   and so on. A person's address on the brand domain is returned immediately,
   spending no Hunter credits. A role mailbox (`press@`) is kept as a fallback
   and only offered when nothing better was found.
   The browser usually forwards the text it already scraped (`pageText`); when
   it does not, the service fetches `/`, `/contact`, `/contact-us`, `/about` and
   `/about-us` itself within `SITE_TEXT_TIMEOUT_MS`.
2. **Candidate ranking.** When Hunter returns several people, their names and
   titles go to Gemini with the question *"Which of these people is most likely
   in charge of Influencer Marketing, Brand Partnerships, or is the Founder?"*
   Only the chosen contact is verified and returned. The answer is matched back
   against the list, so a hallucinated address can never reach the frontend.

Any Gemini failure (no key, timeout, quota, bad JSON) is logged and ignored: the
pipeline continues with Hunter exactly as before.

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
var CONTACT_FALLBACK_API="https://your-service.example.com";   // or .../api/brand-contact
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
| `HUNTER_DOMAIN_SEARCH_LIMIT` | `10` | rows requested from `/v2/domain-search` in Hunter-only mode |
| `ALLOW_USER_HUNTER_KEY` | `true` | accept a visitor's key in `x-hunter-api-key` |
| `GEMINI_API_KEY` | – | optional, enables the two Gemini steps |
| `GEMINI_MODEL` | `gemini-2.5-flash` | Gemini model used for both steps |
| `GEMINI_EMAIL_SCAN` | `true` | read the page text with Gemini before spending Hunter credits |
| `SITE_TEXT_TIMEOUT_MS` | `6000` | budget for downloading the brand's pages when the browser sends no text |

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

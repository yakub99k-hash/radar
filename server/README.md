# Radar contact finder (Hunter.io + Prospeo.io, per-visitor keys)

Small Node.js service that turns a brand domain into a **named, verified contact**
when the brand's own website shows no email address.

It plugs in behind the existing `radar-contacts` Cloudflare Worker: the worker
scrapes the website, this service is the automatic fallback.

**No keys live on the server.** Every request carries the visitor's own provider
and API key (`x-provider`, `x-api-key`); without a key the API answers `400`
*"Please add your own API key first."* The owner's `HUNTER_API_KEY` is not read
any more, so nobody can spend the owner's credits.

```
frontend (index.html)
   │  POST /api/brand-contact  { domain, brand, pageText? }
   │  headers: Authorization (Firebase), x-provider: hunter|prospeo, x-api-key: <visitor key>
   ▼
0. Gemini  reads the page text                (few tokens)  -> an email here costs
           (sent by the browser, or fetched by the service)     nothing else
A. Hunter path (x-provider: hunter)
   1. Hunter  GET  /v2/domain-search             (1 credit)   every address Hunter knows
   2. rank    title scoring -> named contacts before info@ / press@
   3. Gemini  picks the influencer/partnership owner out of the shortlist (few tokens)
   4. verify  reuse the status domain search returned, else /v2/email-verifier
B. Prospeo path (x-provider: prospeo)
   1. Prospeo POST /search-person                (1 credit)   who works at the brand
   2. rank    the same title scoring
   3. Gemini  picks the best sponsorship owner, so the paid enrich is spent on them
   4. Prospeo POST /enrich-person                (1 credit)   verified email of that person
5. filter  off-domain addresses, and info@, press@, support@ ... -> marked as "fallback",
           never returned as a person
6. JSON    { contact_name, title, email, email_status, linkedin_url, found, ... }
```

Both paths return the same JSON shape, so the frontend needs no extra handling.
`meta.strategy` tells you which one answered (`hunter-domain-search` or
`prospeo-search+enrich`), `meta.provider` says which provider was asked for.

## Apollo is off by default

Apollo.io would be billed to the owner's `APOLLO_API_KEY`, which is exactly what
this service is no longer allowed to do for visitor requests. The Apollo people
search therefore only runs when the owner opts in with
`CONTACT_USE_APOLLO=true` (and a real `APOLLO_API_KEY`); it then acts as a faster
route to a LinkedIn handle in front of the Hunter path. Leave it off and every
lookup stays on the visitor's own key.


## Hunter vs Prospeo

Both providers are ranked with the same rules: matching job titles first, named
contacts before `info@`/`press@`, then off-domain addresses are dropped.

- **Hunter** domain search returns people, titles, LinkedIn profiles and often a
  verification status in one call. Only the best few are verified, and only when
  domain search did not already report a status, so the cost stays at roughly one
  domain search plus one verification.
- **Prospeo** splits into `search-person` (who works there, no emails yet, 1
  credit) and `enrich-person` (reveals the verified email, 1 credit). Gemini orders
  the shortlist first so the paid enrichment lands on the most likely sponsorship
  owner; at most `MAX_EMAILS_TO_VERIFY` people are enriched per domain.

A real 503 is only returned when the configured provider cannot run at all.

## Why two Apollo calls?

Apollo's people **search** endpoint is anonymised on purpose: it returns
`first_name` plus `last_name_obfuscated` (`Do***e`) and **no** LinkedIn URL. The
`people/match` endpoint returns the real `name` and `linkedin_url`. The LinkedIn
handle is also the most accurate input for Hunter, so it is fetched once for the
best candidate only (cost control). This path only runs with
`CONTACT_USE_APOLLO=true`.

## API

`GET` or `POST /api/brand-contact`

| input | where | notes |
| --- | --- | --- |
| `domain` | query or JSON body | required, `https://www.brand.com/x` is cleaned to `brand.com` |
| `brand` | query or JSON body | optional, used for the Prospeo name fallback |
| `pageText` | JSON body | optional, the page text the browser already scraped for the Gemini step (max 40 kB) |
| `x-provider` | header | required in practice: `hunter` (default) or `prospeo` |
| `x-api-key` | header | **required**: the visitor's own key for that provider (max 200 chars) |
| `x-hunter-api-key` | header | legacy alias of `x-api-key` for pages cached before the switch |

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
`HUNTER_CREDIT_LIMIT` is shown by the UI as **"API Limit Reached - Please add your
own Hunter key"** (Hunter 402/429) or **"... your own Prospeo key"** for Prospeo.

Errors use normal HTTP codes with `{ "error": "...", "code": "..." }`
(400 missing/invalid domain, 400 `API_KEY_MISSING`, 400 `INVALID_PROVIDER`,
401 bad login or rejected provider key, 429 upstream rate limit, 5xx).

Health check: `GET /healthz` -> `{ ok, providers, userKeysRequired, apollo, gemini, auth, uptime_s }`

## Bring your own key

The frontend stores each visitor's Hunter and Prospeo keys in `localStorage` and
sends the one they picked as `x-api-key` together with `x-provider`. The service
builds a client for that key and uses it for **that request only**, so a visitor
never spends the owner's credits and no server key is ever exposed.

There is **no fallback**: a request without `x-api-key` (or `x-hunter-api-key`)
is answered with `400` and *"Please add your own API key first."* before any
provider is contacted. Keys are never logged and never put in URLs.

## The Gemini steps

Both are optional; configure `GEMINI_API_KEY` to switch them on.

1. **Page text scan** (before any paid call). Gemini reads the text of the
   brand's pages and returns addresses the regex-based scraper misses -
   `press [at] brand [dot] com`, addresses only in JSON-LD, in image alt text,
   and so on. A person's address on the brand domain is returned immediately,
   spending no Hunter/Prospeo credits. A role mailbox (`press@`) is kept as a
   fallback and only offered when nothing better was found.
   The browser usually forwards the text it already scraped (`pageText`); when
   it does not, the service fetches `/`, `/contact`, `/contact-us`, `/about` and
   `/about-us` itself within `SITE_TEXT_TIMEOUT_MS`.
2. **Candidate ranking.** When the provider returns several people, their
   names and titles go to Gemini with the question *"Which of these people is
   most likely in charge of Influencer Marketing, Brand Partnerships, or is the
   Founder?"* Only the chosen contact is returned (Hunter) or enriched first
   (Prospeo). The answer is matched back against the list, so a hallucinated
   address can never reach the frontend.

Any Gemini failure (no key, timeout, quota, bad JSON) is logged and ignored: the
pipeline continues with the provider exactly as before.

## Setup

```bash
cd server
npm install
cp ../.env.example ../.env      # only GEMINI_API_KEY is worth filling in
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
| `APOLLO_API_KEY` | – | optional, only used when `CONTACT_USE_APOLLO=true` |
| `PORT` | `8787` | HTTP port |
| `ALLOWED_ORIGINS` | empty (`*`) | comma separated browser origins |
| `FIREBASE_WEB_API_KEY` | empty | the `apiKey` from `FIREBASE_CONFIG` in `index.html` |
| `REQUIRE_AUTH` | `false` | require `Authorization: Bearer <firebase id token>` |
| `CONTACT_USE_APOLLO` | `false` | run the Apollo people search (owner's credits!) before Hunter |
| `CONTACT_TITLES` | Influencer Marketing, Partnerships, Creator Relations, Social Media Manager | job titles to look for at the brand |
| `HUNTER_ACCEPT_STATUSES` | `valid,deliverable` | verifier outcomes that count as verified |
| `ALLOW_ACCEPT_ALL` | `false` | accept catch-all domains (`accept_all` / `risky`) |
| `REQUIRE_BRAND_DOMAIN` | `true` | reject gmail.com etc. |
| `MAX_ENRICHED_CANDIDATES` | `2` | people enriched per brand (Prospeo credits) |
| `MAX_EMAILS_TO_VERIFY` | `2` | Hunter verifier / Prospeo enrich calls per brand |
| `CACHE_TTL_SECONDS` | `21600` | cached successful lookups (0 disables) |
| `CACHE_NEGATIVE_TTL_SECONDS` | `1800` | cached "nothing found" answers |
| `MAX_CONCURRENT_LOOKUPS` | `3` | parallel brand lookups |
| `HTTP_TIMEOUT_MS` / `HTTP_RETRIES` | `15000` / `2` | outbound HTTP policy |
| `HUNTER_POLL_ATTEMPTS` / `HUNTER_POLL_DELAY_MS` | `3` / `1500` | retries while Hunter verifies (HTTP 202) |
| `MIN_TITLE_SCORE` | `25` | drop irrelevant titles before spending credits |
| `HUNTER_DOMAIN_SEARCH_LIMIT` | `10` | rows requested from `/v2/domain-search` |
| `PROSPEO_SEARCH_LIMIT` | `25` | people read from `/search-person` before ranking |
| `PROSPEO_ONLY_VERIFIED_EMAIL` | `false` | only enrich people Prospeo already verified |
| `PROSPEO_BASE_URL` | `https://api.prospeo.io` | Prospeo API host (tests point it at a fake) |
| `GEMINI_API_KEY` | – | optional, enables the two Gemini steps |
| `GEMINI_MODEL` | `gemini-2.5-flash` | Gemini model used for both steps |
| `GEMINI_EMAIL_SCAN` | `true` | read the page text with Gemini before spending any credits |
| `SITE_TEXT_TIMEOUT_MS` | `6000` | budget for downloading the brand's pages when the browser sends no text |

## Credit safety

- results (including "nothing found") are cached for `CACHE_TTL_SECONDS`;
- identical concurrent requests share one run (`inflight` map);
- only the top `MAX_ENRICHED_CANDIDATES` people are enriched, best title first
  (and Gemini orders them so the first paid lookup is the likely owner);
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
`ALLOWED_ORIGINS` list. Visitors can only spend their own Hunter/Prospeo
credits (their key is mandatory), so the URL itself is no longer a credit risk;
auth just keeps randoms from using your Gemini quota.

## Tests

```bash
cd server && npm test     # node:test, no network, no credits
```

Covers domain cleaning, title ranking, generic mailbox detection, the Apollo,
Hunter and Prospeo clients (mocked), both provider paths, every pipeline branch,
the HTTP layer (retries, timeouts, CORS, auth, the mandatory user key) and full
end-to-end runs against a local fake upstream.

(booleans only, never the keys).

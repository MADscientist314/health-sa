# Claude proxy (`worker.js`)

The dashboard's AI analysis calls the Cloudflare Worker `health-sa-proxy`
(`https://health-sa-proxy.magicalvacations.workers.dev`). The Worker holds the Anthropic API key and
forwards a request to the Claude API only when all of these hold:

- **Origin:** the request comes from an origin in `ALLOWED_ORIGINS` (the GitHub Pages site,
  `https://madscientist314.github.io`). Requests from other sites, or with no `Origin`, get 403.
  This stops other pages from using a visitor's browser. It isn't authentication, because any
  script can set `Origin`.
- **Sign-in:** it carries `Authorization: Bearer <Supabase access token>` for a signed-in,
  non-anonymous user. The Worker asks Supabase Auth (`GET /auth/v1/user`) on every request. That is
  Supabase's recommended check for projects on the legacy JWT secret, and it notices sign-outs at
  once. Expired tokens, the public anon key and tokens from other projects are refused without
  calling Supabase.
- **Rate limits** (D1 table `rate_events`):
  - Each address: 30 requests per 10 minutes and 150 per day. IPv6 addresses count by their /64
    network. Failed sign-ins count, so a flood of bad tokens is cut off before it reaches Supabase.
  - Each user: 15 requests per 10 minutes and 60 per day.
  - Requests refused by a user's own limit don't count against their address. Requests that fail
    on Anthropic's side don't count at all.
- **Shape:** the body matches what the dashboard sends:
  - model `claude-haiku-4-5-20251001`
  - `max_tokens` from 1 to 1,024
  - 1 to 6 plain-text `user` or `assistant` messages, starting with a user message, none blank, each
    at most 10,000 characters
  - an optional text `system` prompt of at most 20,000 characters
  - at most 64 KB in all

  The Worker rebuilds the body from those fields, so tools, thinking, other models, URL-fetched
  images and documents, and any other field never reach the API. It adds `metadata.user_id` (the
  Supabase user's UUID) so Anthropic can attribute abuse to one user.

The answer streams back with only `Content-Type`. Anthropic's account and rate-limit headers are
dropped, and its error details are logged rather than shown.

The Worker fails closed:
- If a var, the secret or the D1 binding is missing, it answers 503 without CORS headers. The
  dashboard then reports a network error.
- If D1 fails, Supabase can't be reached, or Supabase rejects the anon key, it answers a 503 the
  dashboard can read.

**Spend:** at most about 16K input plus 1,024 output tokens per request, roughly $0.02 on Haiku 4.5
for English text. That's about $1.20 per user per day. Denser text, such as other scripts or random
strings, uses more tokens per KB, so treat this as an estimate. The hard cap is the spend limit in
the Anthropic Console.

**Personal data:**
- Prompts carry the patient's lab values, which go to Anthropic.
- Client addresses and Supabase user IDs are kept in D1 for up to a day for the rate limits; IPv6
  addresses are kept as /64 networks.
- The same addresses and IDs appear in Workers Logs when a request is rate-limited.

## Configuration

| Name | Kind | Set in |
|---|---|---|
| `ALLOWED_ORIGINS` | var: comma-separated exact origins | `wrangler.jsonc` |
| `SUPABASE_URL` | var | `wrangler.jsonc` |
| `SUPABASE_ANON_KEY` | var: the public anon key, also in the dashboard | `wrangler.jsonc` |
| `ANTHROPIC_API_KEY` | secret | `npx wrangler@4.152.0 secret put ANTHROPIC_API_KEY` |
| `DB` | D1 binding (schema in `migrations/`) | `wrangler.jsonc` |

`wrangler.jsonc` also does two things:
- It pins the Cloudflare `account_id`.
- It turns off per-version preview URLs (`preview_urls: false`). Otherwise older versions of the
  Worker could stay reachable at `<version>-health-sa-proxy.<subdomain>.workers.dev`.

If you change the model, `max_tokens`, the message limit or the rate limits, change them together in:
- `worker.js`
- `health_sa_dashboard.html` (`MODEL`, `MAX_TOKENS`, `MAX_HISTORY`)
- `tests/worker.test.mjs`

## Deploying

The D1 database `health-sa-proxy` was created on 2026-10-26, and its id is already in
`wrangler.jsonc`. To set up from scratch, for example in another account:

```bash
npx wrangler@4.152.0 login
npx wrangler@4.152.0 d1 create health-sa-proxy   # paste the printed database_id into wrangler.jsonc
```

Every deploy (runs the tests, applies migrations, deploys):

```bash
bash deploy_worker.sh
```

Wrangler keeps the existing `ANTHROPIC_API_KEY` secret across deploys. For a brand-new Worker, set
it with `secret put` straight after the first deploy.

Publish the dashboard (the `gh-pages` branch) right after the Worker is deployed. The new Worker
refuses the old dashboard's access code, and the old Worker refuses the new dashboard's token, so the
AI panel is down until both are live.

To rotate the Anthropic key, deploy first, then do these steps in order:

1. Create a new key in the Anthropic Console.
2. Run `npx wrangler@4.152.0 secret put ANTHROPIC_API_KEY` and paste the new key at the prompt.
3. Check the dashboard still answers.
4. Delete the old key in the Console.

`secret put` creates and deploys a new version of whatever code is live. Deploying first means the
new key never reaches older code.

## Testing

**Unit tests** (Node 22.13+, no install). They run the Worker against an in-memory D1 and fake
Supabase and Claude at the network edge:

```bash
node --test tests/worker.test.mjs
```

**Local Worker** with `wrangler dev`. These checks never reach Claude: every request is refused
before the Worker would call the API, so a placeholder key is enough.

```bash
cp .dev.vars.example .dev.vars
npx wrangler@4.152.0 d1 migrations apply health-sa-proxy --local
npx wrangler@4.152.0 dev
bash tests/dev-checks.sh          # in a second terminal; expect "All checks passed."
```

| Check | Expected |
|---|---|
| Preflight from the dashboard origin | 204, `Access-Control-Allow-Origin` echoes it |
| Preflight or POST from another site, or with no `Origin` | 403 |
| No token, the old `X-Access-Code: HEALTHSA`, or the anon key as the token | 401 |
| `GET` | 405 |
| Non-JSON body | 415 |
| Another model, `max_tokens` 4096, or a URL-fetched document | 400 |
| Body over 64 KB | 413 |
| Attempt 31 from one address within 10 minutes | 429 |

The 30 failed sign-ins before attempt 31 get 401. While Supabase is unreachable they get 503
instead, which the script also accepts. Re-running within 10 minutes reports 429s; delete
`.wrangler/state` to start fresh.

**After deploying:**

1. Sign in at `https://madscientist314.github.io/health-sa/`, generate an analysis and ask four or
   more follow-up questions. All of them should stream.
2. In DevTools → Network, the POST to `health-sa-proxy` carries `Authorization: Bearer …` and no
   `X-Access-Code`.
3. Run `SKIP_RATE_LIMIT=1 bash tests/dev-checks.sh https://health-sa-proxy.magicalvacations.workers.dev`.
   Every check should pass. `SKIP_RATE_LIMIT=1` stops it locking your own address out for 10
   minutes.
4. Watch the logs: `npx wrangler@4.152.0 tail health-sa-proxy`, or Workers Logs in the Cloudflare
   dashboard.

#!/bin/bash
# Checks a running `npx wrangler dev` (http://localhost:8787 by default) without reaching
# Claude: every request below is refused before the Worker would call the API, so the
# placeholder key from .dev.vars.example is enough.
# Usage: bash tests/dev-checks.sh [worker-url]
# The rate-limit check fills this address's 10-minute allowance. Before re-running, wait
# 10 minutes or stop wrangler dev and delete .wrangler/state. Against the deployed Worker,
# set SKIP_RATE_LIMIT=1 so your own address isn't locked out of the dashboard for 10 minutes.
set -uo pipefail

URL=${1:-http://localhost:8787}
ORIGIN=https://madscientist314.github.io
CONFIG="$(dirname "$0")/../wrangler.jsonc"
SUPABASE_URL=$(sed -n 's/.*"SUPABASE_URL": *"\([^"]*\)".*/\1/p' "$CONFIG")
ANON_KEY=$(sed -n 's/.*"SUPABASE_ANON_KEY": *"\([^"]*\)".*/\1/p' "$CONFIG")
fails=0

# Shaped like a session token for this project but unsigned: it passes the Worker's quick
# checks, then Supabase refuses it (401), or the Worker answers 503 if Supabase is unreachable.
FORGED=$(node -e '
  const b = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const claims = { iss: process.argv[1] + "/auth/v1", sub: "00000000-0000-4000-8000-000000000000", role: "authenticated", aud: "authenticated", exp };
  console.log([b({ alg: "HS256", typ: "JWT" }), b(claims), "bm90LXNpZ25lZA"].join("."));
' "$SUPABASE_URL")

body() { # body [field=json ...]: the dashboard's request with fields replaced
  node -e '
    const b = { model: "claude-haiku-4-5-20251001", max_tokens: 1024, stream: true, messages: [{ role: "user", content: "hi" }] };
    for (const kv of process.argv.slice(1)) { const i = kv.indexOf("="); b[kv.slice(0, i)] = JSON.parse(kv.slice(i + 1)); }
    process.stdout.write(JSON.stringify(b));
  ' "$@"
}

expect() { # expect <name> <status> <curl args...>; a body can come on stdin with --data-binary @-
  local name=$1 want=$2 got
  shift 2
  got=$(curl -s -o /dev/null -w '%{http_code}' "$@")
  if [ "$got" = "$want" ]; then
    echo "PASS  $name ($got)"
  else
    echo "FAIL  $name: got $got, expected $want"
    fails=$((fails + 1))
  fi
}

signed_in() { # POST from the dashboard origin with the forged token
  expect "$1" "$2" -X POST "$URL/" -H "Origin: $ORIGIN" -H 'Content-Type: application/json' \
    -H "Authorization: Bearer $FORGED" --data-binary @-
}

echo "Origins"
allow=$(curl -s -o /dev/null -D - -X OPTIONS "$URL/" -H "Origin: $ORIGIN" \
  -H 'Access-Control-Request-Method: POST' -H 'Access-Control-Request-Headers: authorization, content-type' |
  tr -d '\r' | sed -n 's/^[Aa]ccess-[Cc]ontrol-[Aa]llow-[Oo]rigin: *//p')
if [ "$allow" = "$ORIGIN" ]; then echo "PASS  preflight allows the dashboard origin"; else echo "FAIL  preflight allowed '$allow'"; fails=$((fails + 1)); fi
expect 'preflight from another site' 403 -X OPTIONS "$URL/" -H 'Origin: https://evil.example' -H 'Access-Control-Request-Method: POST'
body | expect 'POST from another site' 403 -X POST "$URL/" -H 'Origin: https://evil.example' -H 'Content-Type: application/json' -H "Authorization: Bearer $FORGED" --data-binary @-
body | expect 'POST with no Origin header' 403 -X POST "$URL/" -H 'Content-Type: application/json' -H "Authorization: Bearer $FORGED" --data-binary @-

echo "Sign-in"
body | expect 'no session token' 401 -X POST "$URL/" -H "Origin: $ORIGIN" -H 'Content-Type: application/json' --data-binary @-
body | expect 'old access code' 401 -X POST "$URL/" -H "Origin: $ORIGIN" -H 'Content-Type: application/json' -H 'X-Access-Code: HEALTHSA' --data-binary @-
body | expect 'public anon key as the token' 401 -X POST "$URL/" -H "Origin: $ORIGIN" -H 'Content-Type: application/json' -H "Authorization: Bearer $ANON_KEY" --data-binary @-

echo "Request shape (refused before Supabase or Claude is asked)"
expect 'GET' 405 "$URL/" -H "Origin: $ORIGIN"
body | expect 'body not sent as JSON' 415 -X POST "$URL/" -H "Origin: $ORIGIN" -H 'Content-Type: text/plain' -H "Authorization: Bearer $FORGED" --data-binary @-
body model='"claude-opus-5-5"' | signed_in 'another model' 400
body max_tokens=4096 | signed_in 'max_tokens over 1024' 400
body messages='[{"role":"user","content":[{"type":"document","source":{"type":"url","url":"https://example.com/a.pdf"}}]}]' | signed_in 'URL-fetched document' 400
node -e 'process.stdout.write(JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 1024, system: "x".repeat(70000), messages: [{ role: "user", content: "hi" }] }))' |
  signed_in 'body over 64 KB' 413

if [ "${SKIP_RATE_LIMIT:-0}" = 1 ]; then
  echo "Rate limit: skipped (SKIP_RATE_LIMIT=1)"
else
  echo "Rate limit (30 attempts per address per 10 minutes, failed sign-ins included)"
  for i in $(seq 1 30); do
    code=$(body | curl -s -o /dev/null -w '%{http_code}' -X POST "$URL/" -H "Origin: $ORIGIN" -H 'Content-Type: application/json' \
      -H "Authorization: Bearer $FORGED" --data-binary @-)
    if [ "$code" != 401 ] && [ "$code" != 503 ]; then
      echo "FAIL  attempt $i: got $code, expected 401 (or 503 while Supabase is unreachable)"
      fails=$((fails + 1))
      break
    fi
  done
  body | signed_in 'attempt 31 from this address' 429
fi

echo
if [ "$fails" -eq 0 ]; then echo "All checks passed."; else echo "$fails check(s) failed."; fi
[ "$fails" -eq 0 ]

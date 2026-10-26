#!/bin/bash
# Deploys the Claude proxy (worker.js) with Wrangler, which takes its D1 binding, vars and
# settings from wrangler.jsonc. First-time setup and checks are in PROXY.md.
# The Anthropic key is a Worker secret: set it with `npx wrangler@4.152.0 secret put ANTHROPIC_API_KEY`,
# never from a file or on the command line.
set -euo pipefail
cd "$(dirname "$0")"
WRANGLER="npx wrangler@4.152.0"

node --test tests/worker.test.mjs
$WRANGLER d1 migrations apply health-sa-proxy --remote
$WRANGLER deploy

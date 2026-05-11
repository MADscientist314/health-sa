#!/bin/bash

CF_KEY=$(cat /mnt/d/github/JJochum/HeathSA/.cloudflare_apikey | tr -d '\n\r ')
ACCOUNT_ID="86402922a1ab0cd7c5e68f19ce78cd0b"
SCRIPT_NAME="health-sa-proxy"
ANTHROPIC_KEY=$(cat /mnt/d/github/JJochum/HeathSA/.apikey | tr -d '\n\r ')

echo "Deploying worker: $SCRIPT_NAME"
echo "Key length: ${#CF_KEY}"

# Upload worker script
UPLOAD=$(curl -s -X PUT \
  "https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/scripts/${SCRIPT_NAME}" \
  -H "Authorization: Bearer ${CF_KEY}" \
  -F "metadata={\"main_module\":\"worker.js\",\"compatibility_date\":\"2024-01-01\"};type=application/json" \
  -F "worker.js=@/mnt/d/github/JJochum/HeathSA/worker.js;type=application/javascript+module")

echo "Upload raw: $UPLOAD"
echo "Upload result: $(echo $UPLOAD | python3 -c 'import sys,json; r=json.load(sys.stdin); print("OK" if r.get("success") else r.get("errors"))')"

if echo "$UPLOAD" | python3 -c 'import sys,json; sys.exit(0 if json.load(sys.stdin).get("success") else 1)'; then
  # Set the Anthropic API key as a secret
  SECRET=$(curl -s -X PUT \
    "https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/scripts/${SCRIPT_NAME}/secrets" \
    -H "Authorization: Bearer ${CF_KEY}" \
    -H "Content-Type: application/json" \
    -d "{\"name\":\"ANTHROPIC_API_KEY\",\"text\":\"${ANTHROPIC_KEY}\",\"type\":\"secret_text\"}")
  echo "Secret result: $(echo $SECRET | python3 -c 'import sys,json; r=json.load(sys.stdin); print("OK" if r.get("success") else r.get("errors"))')"

  # Enable workers.dev subdomain
  SUB=$(curl -s -X POST \
    "https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/scripts/${SCRIPT_NAME}/subdomain" \
    -H "Authorization: Bearer ${CF_KEY}" \
    -H "Content-Type: application/json" \
    -d '{"enabled":true}')
  echo "Subdomain result: $(echo $SUB | python3 -c 'import sys,json; r=json.load(sys.stdin); print("OK" if r.get("success") else r.get("errors"))')"

  # Get the workers.dev subdomain name for the account
  ACCT=$(curl -s -X GET \
    "https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/subdomain" \
    -H "Authorization: Bearer ${CF_KEY}")
  SUBDOMAIN=$(echo $ACCT | python3 -c 'import sys,json; r=json.load(sys.stdin); print(r.get("result",{}).get("subdomain",""))')
  echo "Worker URL: https://${SCRIPT_NAME}.${SUBDOMAIN}.workers.dev"
else
  echo "Upload failed, skipping secrets"
  echo "Full response: $UPLOAD"
fi

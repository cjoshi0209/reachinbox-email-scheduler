#!/usr/bin/env bash
# Writes backend/.env for a hosted deployment from backend/.env.example.
#   HOST_URL=https://your-host GOOGLE_CLIENT_ID=... SLACK_CLIENT_ID=... scripts/hosted-env.sh
# Session/encryption keys are generated fresh on the host. OAuth client *secrets* are NOT
# written here: provide GOOGLE_CLIENT_SECRET / SLACK_CLIENT_SECRET as environment variables
# (e.g. GitHub Codespaces secrets), which take precedence over .env.
set -euo pipefail
cd "$(dirname "$0")/../backend"
: "${HOST_URL:?HOST_URL is required}"
session=$(node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))")
enc=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")
sed \
  -e "s|^NODE_ENV=.*|NODE_ENV=production|" \
  -e "s|^API_URL=.*|API_URL=${HOST_URL}|" \
  -e "s|^FRONTEND_URL=.*|FRONTEND_URL=${HOST_URL}|" \
  -e "s|^SESSION_SECRET=.*|SESSION_SECRET=${session}|" \
  -e "s|^ENCRYPTION_KEY=.*|ENCRYPTION_KEY=${enc}|" \
  -e "s|^GOOGLE_CLIENT_ID=.*|GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID:-}|" \
  -e "/^GOOGLE_CLIENT_SECRET=/d" \
  -e "s|^GOOGLE_REDIRECT_URI=.*|GOOGLE_REDIRECT_URI=${HOST_URL}/auth/google/callback|" \
  -e "s|^SLACK_CLIENT_ID=.*|SLACK_CLIENT_ID=${SLACK_CLIENT_ID:-}|" \
  -e "/^SLACK_CLIENT_SECRET=/d" \
  -e "s|^SLACK_REDIRECT_URI=.*|SLACK_REDIRECT_URI=${HOST_URL}/auth/slack/callback|" \
  .env.example > .env
echo "wrote backend/.env for ${HOST_URL}"
echo "GOOGLE_CLIENT_SECRET in env: $([ -n "${GOOGLE_CLIENT_SECRET:-}" ] && echo yes || echo no)"
echo "SLACK_CLIENT_SECRET in env:  $([ -n "${SLACK_CLIENT_SECRET:-}" ] && echo yes || echo no)"

#!/usr/bin/env bash
set -euo pipefail

: "${GITHUB_REF:?GITHUB_REF is required}"
: "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"

configured=0
for value in \
  "${REMOTE_REGISTRY_URL:-}" \
  "${REMOTE_REGISTRY_NAMESPACE:-}" \
  "${REMOTE_REGISTRY_REPOSITORY:-}" \
  "${REMOTE_REGISTRY_USERNAME:-}" \
  "${REMOTE_REGISTRY_PASSWORD:-}"; do
  if [[ -n "$value" ]]; then
    configured=$((configured + 1))
  fi
done

if [[ "$configured" -eq 0 ]]; then
  echo "::notice::Secondary registry is not configured; publishing only to GHCR."
elif [[ "$configured" -ne 5 ]]; then
  echo "::error::Secondary registry configuration is incomplete; set all REMOTE_REGISTRY variables and credentials."
  exit 1
elif [[ "$GITHUB_REF" == "refs/heads/master" || "$GITHUB_REF" == refs/tags/* ]]; then
  echo "enabled=true" >> "$GITHUB_OUTPUT"
else
  echo "::notice::Branch builds publish only to GHCR."
fi

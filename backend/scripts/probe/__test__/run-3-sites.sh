#!/bin/bash
# Run pre-bootstrap on the 3 untested Tier-1 sites (aagcanada, theammosource, gunpost).
# Sequential to avoid IP pressure / heavy-WAF-probe process pool exhaustion.
# Per-site timeout 900s (15 min) since walks may be slow on large sites.
set -u
cd "$(dirname "$0")/../../.."  # ensure cwd = backend/
SITES=(
  "https://aagcanada.ca/"
  "https://theammosource.com/"
  "https://gunpost.ca/"
)
for site in "${SITES[@]}"; do
  echo ""
  echo "========================================"
  echo "=== START $site $(date +%H:%M:%S) ==="
  echo "========================================"
  timeout 900 npx tsx scripts/pre-bootstrap.ts "$site" 2>&1 | tail -60
  echo "=== END $site exit=${PIPESTATUS[0]} $(date +%H:%M:%S) ==="
done
echo ""
echo "========================================"
echo "ALL DONE $(date +%H:%M:%S)"
echo "========================================"

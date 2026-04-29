#!/bin/bash
# Run pre-bootstrap on the 4 remaining Tier-1 sites with new code
# Usage: from backend/ directory: bash scripts/probe/__test__/run-4-sites.sh
set -u
cd "$(dirname "$0")/../../.."  # ensure cwd = backend/
SITES=(
  "https://canadafirstammo.ca/"
  "https://aagcanada.ca/"
  "https://theammosource.com/"
  "https://gunpost.ca/"
)
for site in "${SITES[@]}"; do
  echo "=== START $site $(date +%H:%M:%S) ==="
  timeout 600 npx tsx scripts/pre-bootstrap.ts "$site" 2>&1 | grep -E "^\[Room|HARD|FAIL|drift|walked|expected|wrote profile|catalogUrls=|globalProductCount" | head -30
  echo "=== END $site exit=${PIPESTATUS[0]} $(date +%H:%M:%S) ==="
done

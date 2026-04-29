#!/bin/bash
# Run pre-bootstrap on all 5 Tier-1 sites, sequential, with Round 2 redesigned code.
# Per-site timeout 1800s (30 min) to allow large catalogs (theammosource, gunpost) time to walk.
# Bug R2-3 fix: raised from 1200s after canadafirstammo/theammosource/gunpost all timed out at 20 min.
set -u
cd "$(dirname "$0")/../../.."  # ensure cwd = backend/
SITES=(
  "https://canadafirstammo.ca/"
  "https://aagcanada.ca/"
  "https://theammosource.com/"
  "https://bullseyenorth.com/"
  "https://gunpost.ca/"
)
for site in "${SITES[@]}"; do
  echo ""
  echo "========================================"
  echo "=== START $site $(date +%H:%M:%S) ==="
  echo "========================================"
  timeout 1800 npx tsx scripts/pre-bootstrap.ts "$site" 2>&1 | tail -50
  echo "=== END $site exit=${PIPESTATUS[0]} $(date +%H:%M:%S) ==="
done
echo ""
echo "========================================"
echo "ALL DONE $(date +%H:%M:%S)"
echo "========================================"

#!/usr/bin/env bash
# Heavy multi-probe WAF verification
# Usage: ./heavy-waf-probe.sh https://target.example.com
# Fires 8 probe batches designed to trigger behavior-based WAFs.
# Reports HTTP status, response time, headers, cookies for each.

set -u
DOMAIN="${1:-}"
if [[ -z "$DOMAIN" ]]; then
  echo "usage: $0 https://example.com"
  exit 1
fi

# Ensure no trailing slash
DOMAIN="${DOMAIN%/}"

DESKTOP_UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
MOBILE_UA='Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1'
BOT_UA='python-requests/2.31.0'
CURL_UA='curl/8.1.2'

probe() {
  local label="$1"; shift
  local url="$1"; shift
  local t0 t1 dur
  t0=$(date +%s%N)
  local out
  out=$(curl -sSL -o /dev/null -w "STATUS=%{http_code} BYTES=%{size_download} TIME=%{time_total} REDIRECTS=%{num_redirects} FINAL=%{url_effective}" --max-time 20 "$@" "$url" 2>&1)
  t1=$(date +%s%N)
  dur=$(( (t1 - t0) / 1000000 ))
  echo "[$label] $url"
  echo "   $out"
  echo "   wall_ms=$dur"
}

probe_headers() {
  local label="$1"; shift
  local url="$1"; shift
  echo "[$label] HEADERS FOR $url"
  curl -sSLI --max-time 20 -A "$DESKTOP_UA" "$@" "$url" 2>&1 | grep -iE '^(HTTP|server|cf-ray|cf-cache|x-sucuri|x-amz|x-waf|x-cache|set-cookie|via|x-served|location)' | head -30
  echo
}

echo "========================================"
echo "HEAVY WAF PROBE: $DOMAIN"
echo "Date: $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
echo "========================================"

# ── PRE-FLIGHT: resolve canonical host ─────────────────────────────────
# Many sites run the apex on one stack (IIS/Apache/cPanel) that 301s to
# `www` which is behind the CDN/WAF. Probing only the apex will miss the
# real WAF. Resolve the canonical host by following redirects ONCE and
# report if apex and www differ. (Site 24 reliablegun.com lesson.)
echo
echo "=== PRE-FLIGHT: canonical host resolution ==="
APEX_FINAL=$(curl -sSLI --max-time 20 -A "$DESKTOP_UA" -o /dev/null -w '%{url_effective}' "$DOMAIN" 2>/dev/null || echo "$DOMAIN")
APEX_SERVER=$(curl -sSI --max-time 20 -A "$DESKTOP_UA" "$DOMAIN" 2>/dev/null | grep -i '^server:' | head -1 || true)
FINAL_SERVER=$(curl -sSLI --max-time 20 -A "$DESKTOP_UA" "$DOMAIN" 2>/dev/null | grep -i '^server:' | tail -1 || true)
echo "   requested: $DOMAIN"
echo "   canonical: $APEX_FINAL"
echo "   apex_server_header:     $APEX_SERVER"
echo "   canonical_server_header: $FINAL_SERVER"
if [[ "$APEX_FINAL" != "$DOMAIN/" && "$APEX_FINAL" != "$DOMAIN" ]]; then
  echo "   ⚠️  Apex redirects to a different canonical host. All probes below target the canonical."
  DOMAIN="${APEX_FINAL%/}"
fi

echo
echo "=== BATCH 1: header fingerprint (single GET per path) ==="
probe_headers "1a" "$DOMAIN/"
probe_headers "1b" "$DOMAIN/robots.txt"
probe_headers "1c" "$DOMAIN/sitemap.xml"

echo
echo "=== BATCH 2: multi-UA probe (3 different UAs on same path) ==="
probe "2a-desktop" "$DOMAIN/" -A "$DESKTOP_UA"
probe "2b-mobile"  "$DOMAIN/" -A "$MOBILE_UA"
probe "2c-bot"     "$DOMAIN/" -A "$BOT_UA"
probe "2d-curl"    "$DOMAIN/" -A "$CURL_UA"

echo
echo "=== BATCH 3: rapid burst (10 sequential GETs in ~2s) ==="
for i in 1 2 3 4 5 6 7 8 9 10; do
  probe "3-burst-$i" "$DOMAIN/?cache_bust=$i$(date +%s%N)" -A "$DESKTOP_UA"
done

echo
echo "=== BATCH 4: honeypot/admin path probe (common WAF trigger paths) ==="
probe "4a-wp-admin"  "$DOMAIN/wp-admin/"   -A "$DESKTOP_UA"
probe "4b-wp-login"  "$DOMAIN/wp-login.php" -A "$DESKTOP_UA"
probe "4c-xmlrpc"    "$DOMAIN/xmlrpc.php"   -A "$DESKTOP_UA"
probe "4d-dotenv"    "$DOMAIN/.env"         -A "$DESKTOP_UA"
probe "4e-dotgit"    "$DOMAIN/.git/config"  -A "$DESKTOP_UA"
probe "4f-phpinfo"   "$DOMAIN/phpinfo.php"  -A "$DESKTOP_UA"

echo
echo "=== BATCH 5: suspicious-fingerprint GET (no Accept-Language, no Accept-Encoding) ==="
probe "5a-barebones" "$DOMAIN/" -A "$DESKTOP_UA" -H "Accept: */*" -H "Accept-Language: " -H "Accept-Encoding: "

echo
echo "=== BATCH 6: SQL-injection-shaped query string (fires SQLi WAF rules if any) ==="
probe "6a-sqli" "$DOMAIN/?id=1'%20OR%20'1'='1" -A "$DESKTOP_UA"
probe "6b-union" "$DOMAIN/?id=1%20UNION%20SELECT%201,2,3" -A "$DESKTOP_UA"

echo
echo "=== BATCH 7: XSS-shaped query string (fires XSS WAF rules) ==="
probe "7a-xss" "$DOMAIN/?q=<script>alert(1)</script>" -A "$DESKTOP_UA"

echo
echo "=== BATCH 8: User-Agent absent (many WAFs require UA) ==="
probe "8a-noUA" "$DOMAIN/" -A ""

echo
echo "========================================"
echo "PROBE COMPLETE"
echo "========================================"
echo
echo "INTERPRETATION GUIDE:"
echo "  - All probes 200 + consistent timing + no cf-ray/x-sucuri → hasWaf: false (HIGH confidence)"
echo "  - Any batch returns 403/503/challenge body → hasWaf: true, wafType = vendor"
echo "  - Honeypot paths 403 but category 200 → hasWaf: true, wafType: 'path-selective'"
echo "  - SQLi/XSS 403 but normal 200 → hasWaf: true, wafType: 'rule-selective'"
echo "  - Rapid burst triggers 429/503 → hasWaf: true, wafType: 'rate-limit'"
echo "  - cf-ray header present but all 200 → hasWaf: true, wafType: 'cloudflare-passive'"

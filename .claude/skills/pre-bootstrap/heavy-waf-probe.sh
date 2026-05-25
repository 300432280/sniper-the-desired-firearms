#!/usr/bin/env bash
# Heavy multi-probe WAF verification
# Usage: ./heavy-waf-probe.sh https://target.example.com [--sustained]
# Fires 8 probe batches designed to trigger behavior-based WAFs.
# Reports HTTP status, response time, headers, cookies for each.
# --sustained adds Batch 9: 50-page walk per production UA at 800ms cadence.
# Batch 9 added 2026-05-19 per batch-4 R4 D2: g4cgunstore.com proved that
# Cloudflare can escalate Chrome-UA requests to 403 after ~60s of sustained
# crawl-like requests while a single-shot multi-UA matrix snapshot shows
# every UA at 200. R2 promotion to operator review MUST invoke --sustained.

set -u
DOMAIN=""
SUSTAINED=0
for arg in "$@"; do
  case "$arg" in
    --sustained) SUSTAINED=1 ;;
    -*) echo "unknown flag: $arg" >&2; exit 1 ;;
    *) [[ -z "$DOMAIN" ]] && DOMAIN="$arg" ;;
  esac
done
if [[ -z "$DOMAIN" ]]; then
  echo "usage: $0 https://example.com [--sustained]"
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
  # Use GET (-sSL, not -I) because some WAFs only serve WAF-specific headers
  # on GET, not HEAD. SiteGround sgcaptcha in particular: HEAD returns a plain
  # 202 with no sg-captcha header, but GET returns 202 + `sg-captcha: challenge`
  # + the meta-refresh challenge body. Discard body via -o /dev/null then pull
  # headers from the -D dump. Also expanded the header filter to catch
  # sg-captcha, cf-mitigated, x-iinfo (Incapsula), x-cdn, x-drupal-*,
  # x-commerce-core, x-frame-options so the probe parser has more signals.
  local tmphdr
  tmphdr=$(mktemp)
  curl -sSL --max-time 20 -A "$DESKTOP_UA" -D "$tmphdr" -o /dev/null "$@" "$url" 2>/dev/null
  grep -iE '^(HTTP|server|cf-ray|cf-cache|cf-mitigated|x-sucuri|x-amz|x-waf|x-cache|set-cookie|via|x-served|location|sg-captcha|x-iinfo|x-cdn|x-varnish|x-akamai|x-bot|x-content|x-powered-by|x-generator|x-drupal|x-commerce-core|x-frame-options)' "$tmphdr" 2>/dev/null | head -30
  rm -f "$tmphdr"
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

if [[ "$SUSTAINED" == "1" ]]; then
  echo
  echo "=== BATCH 9: SUSTAINED PATTERN (50 pages of /shop/page/N/ @ 800ms per production UA) ==="
  # Mirrors the production UA rotation pool at backend/src/services/scraper/http-client.ts:9-14
  # so that any escalation pattern that fires on the real crawler also fires here.
  # Batch-4 R4 lesson (g4cgunstore.com): Cloudflare bot-fight escalated Chrome 120
  # to 403 after ~60s of crawl-like requests while Safari 17 + Firefox 121 stayed
  # 200 in the same window — a single-shot multi-UA matrix (Batch 2) missed it.
  # R2 promotion to operator review MUST invoke --sustained and check per-UA status.
  SUSTAINED_UAS=(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15'
    'Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0'
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Edge/120.0.0.0'
  )
  SUSTAINED_UA_LABELS=(chrome120 safari17 firefox121 edge120)
  for idx in 0 1 2 3; do
    ua="${SUSTAINED_UAS[$idx]}"
    label="${SUSTAINED_UA_LABELS[$idx]}"
    echo "--- BATCH 9 sub-run: $label ($ua) ---"
    for n in $(seq 1 50); do
      probe "9-$label-p$n" "$DOMAIN/shop/page/$n/" -A "$ua"
      sleep 0.8
    done
  done
fi

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
echo "  - Batch 9 (--sustained) some UAs flip 200→403 partway through 50-page walk →"
echo "    hasWaf: true, set userAgentOverride to one of the UAs that stayed 200 throughout."

// backend/scripts/probe/access-identity/waf-heavy-probe.ts
// Wrapper around backend/scripts/heavy-waf-probe.sh (8-batch probe).
// Parses the bash script's output into structured HeavyProbeBatchResult[].

import { spawn } from 'child_process';
import * as path from 'path';
import type { HeavyProbeBatchResult } from '../shared/types';

const SCRIPT_PATH = path.join(process.cwd(), 'scripts', 'heavy-waf-probe.sh');

export type HeavyProbeOutput = {
  rawOutput: string;
  batches: HeavyProbeBatchResult[];
};

export async function runHeavyWafProbe(targetUrl: string): Promise<HeavyProbeOutput> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const child = spawn('bash', [SCRIPT_PATH, targetUrl], {
      timeout: 180000,  // 3 minutes
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => {
      const elapsedMs = Date.now() - start;
      if (code !== 0 && stdout.length < 500) {
        reject(new Error(`heavy-waf-probe.sh exited ${code}: ${stderr}`));
        return;
      }
      resolve({ rawOutput: stdout, batches: parseBatches(stdout, elapsedMs) });
    });
    child.on('error', reject);
  });
}

// Bash script emits two output formats per batch:
// - Batch 1 (header-fingerprint format): `HTTP/X NNN` status lines + `header: value` lines.
//   Captures vendor markers (cf-ray, x-sucuri-id, x-iinfo, server, etc).
// - Batches 2-8 (compact-summary format): `STATUS=NNN BYTES=... TIME=...` per sub-probe.
//   No headers — used for rate-limit / UA-filter / OWASP rule detection via status code only.
const HTTP_STATUS_RE = /^HTTP\/(?:[12]\.[01]|[23])\s+(\d{3})/;
const COMPACT_STATUS_RE = /\bSTATUS=(\d{3})\b/;

function parseBatches(output: string, totalElapsedMs: number): HeavyProbeBatchResult[] {
  const batches: HeavyProbeBatchResult[] = [];
  // Match `=== BATCH N: <description> ===` followed by content until next batch or EOF
  const re = /===\s*BATCH\s+(\d+):\s*([^=]+?)\s*===([\s\S]*?)(?=\n===\s*BATCH|\n*$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(output)) !== null) {
    const [, idStr, description, content] = m;
    const headers: Record<string, string> = {};
    const allStatuses: number[] = [];
    // Parse both formats; whichever matches per-line wins.
    for (const line of content.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      // Format 1: HTTP status line (batch 1)
      const httpMatch = HTTP_STATUS_RE.exec(t);
      if (httpMatch) { allStatuses.push(parseInt(httpMatch[1], 10)); continue; }
      // Format 2: STATUS=NNN compact summary (batches 2-8)
      const compactMatch = COMPACT_STATUS_RE.exec(t);
      if (compactMatch) { allStatuses.push(parseInt(compactMatch[1], 10)); continue; }
      // Header line (batch 1 only — batches 2-8 emit no headers)
      const hMatch = /^([a-z][a-z0-9-]*?):\s*(.+)$/i.exec(t);
      if (hMatch) headers[hMatch[1].toLowerCase()] = hMatch[2];
    }
    // Each batch has multiple curl probes (sub-tests 1a/1b/1c, multi-UA, etc).
    // For WAF detection, the highest status seen is the most informative — any
    // 4xx/5xx in the batch means at least one probe was rejected. 1xx informational
    // statuses (e.g. HTTP/2 103 Early Hints) are filtered out before max-selection.
    const meaningful = allStatuses.filter(s => s >= 200);
    const status = meaningful.length > 0 ? Math.max(...meaningful) : null;
    batches.push({
      batchId: parseInt(idStr, 10),
      description: description.trim(),
      status,
      headers,
      bodySnippet: content.slice(0, 2048),
      // Per-batch duration unavailable — bash script doesn't emit per-batch timing.
      // Set to total/8 as a coarse approximation; consumers should treat as informational only.
      durationMs: Math.round(totalElapsedMs / Math.max(1, batches.length + 1)),
    });
  }
  return batches;
}

// backend/scripts/probe/room2-access-identity/waf-heavy-probe.ts
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
      if (code !== 0 && stdout.length < 500) {
        reject(new Error(`heavy-waf-probe.sh exited ${code}: ${stderr}`));
        return;
      }
      resolve({ rawOutput: stdout, batches: parseBatches(stdout) });
    });
    child.on('error', reject);
  });
}

function parseBatches(output: string): HeavyProbeBatchResult[] {
  const batches: HeavyProbeBatchResult[] = [];
  // Match `=== BATCH N: <description> ===` followed by content until next batch or EOF
  const re = /===\s*BATCH\s+(\d+):\s*([^=]+?)\s*===([\s\S]*?)(?=\n===\s*BATCH|\n*$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(output)) !== null) {
    const [, idStr, description, content] = m;
    const headers: Record<string, string> = {};
    let status: number | null = null;
    // Parse header lines: `header-name: value`
    for (const line of content.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      const httpMatch = /^HTTP\/[12]\.[01]?\s+(\d{3})/.exec(t);
      if (httpMatch) { status = parseInt(httpMatch[1], 10); continue; }
      const hMatch = /^([a-z][a-z0-9-]*?):\s*(.+)$/i.exec(t);
      if (hMatch) headers[hMatch[1].toLowerCase()] = hMatch[2];
    }
    batches.push({
      batchId: parseInt(idStr, 10),
      description: description.trim(),
      status,
      headers,
      bodySnippet: content.slice(0, 2048),
      durationMs: 0,
    });
  }
  return batches;
}

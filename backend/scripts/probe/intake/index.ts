// backend/scripts/probe/intake/index.ts
// Intake stage: URL validation + canonicalization. No DB writes. No HTTP. Per spec §4.1.

import { randomUUID } from 'crypto';
import { canonicalizeUrl } from './validate-url';
import type { IntakeState, StageFailure } from '../shared/types';

export async function runIntake(inputUrl: string): Promise<IntakeState | StageFailure> {
  try {
    const canonicalUrl = canonicalizeUrl(inputUrl);
    return {
      inputUrl,
      canonicalUrl,
      timestamp: new Date().toISOString(),
      runId: randomUUID(),
    };
  } catch (err) {
    return {
      stageFailed: true,
      stageNumber: 1,
      reason: (err as Error).message,
      evidence: { inputUrl },
      timestamp: new Date().toISOString(),
    };
  }
}

// backend/scripts/probe/room1-intake/index.ts
// Room 1: Intake. URL validation + canonicalization. No DB writes. No HTTP. Per spec §4.1.

import { randomUUID } from 'crypto';
import { canonicalizeUrl } from './validate-url';
import type { IntakeState, RoomFailure } from '../shared/types';

export async function runRoom1(inputUrl: string): Promise<IntakeState | RoomFailure> {
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
      roomFailed: true,
      roomNumber: 1,
      reason: (err as Error).message,
      evidence: { inputUrl },
      timestamp: new Date().toISOString(),
    };
  }
}

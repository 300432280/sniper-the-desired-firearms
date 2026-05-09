// backend/scripts/probe/access-identity/platform-detect.ts
import type { PlatformTag, PlatformMarkerEvidence } from '../shared/types';

export type DetectorInput = {
  url: string;
  html: string;
  headers: Record<string, string>;
  cookies: string[];
};

export type DetectorOutput = {
  matched: boolean;
  confidence: 'high' | 'medium' | 'low';
  signals: Record<string, unknown>;
};

export interface PlatformDetector {
  id: PlatformTag;
  detect(input: DetectorInput): Promise<DetectorOutput>;
}

import { detectors } from './detectors';

export async function detectPlatform(input: DetectorInput): Promise<PlatformMarkerEvidence | null> {
  const matches: Array<{ d: PlatformDetector; out: DetectorOutput }> = [];
  for (const d of detectors) {
    const out = await d.detect(input);
    if (out.matched) matches.push({ d, out });
  }
  if (matches.length === 0) return null;
  // Highest confidence wins; ties → first registered
  matches.sort((a, b) => CONF_RANK[b.out.confidence] - CONF_RANK[a.out.confidence]);
  const winner = matches[0];
  return {
    detectorId: winner.d.id,
    confidence: winner.out.confidence,
    signals: winner.out.signals,
  };
}

const CONF_RANK = { high: 3, medium: 2, low: 1 } as const;

// backend/scripts/probe/intake/__test__/index.test.ts
import { describe, it, expect } from 'vitest';
import { runIntake } from '../index';

describe('runIntake', () => {
  it('returns IntakeState with canonicalUrl + runId for valid input', async () => {
    const r = await runIntake('https://Example.COM/');
    if ('stageFailed' in r) throw new Error('expected pass');
    expect(r.canonicalUrl).toBe('https://example.com/');
    expect(r.runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(r.inputUrl).toBe('https://Example.COM/');
  });
  it('rejects malformed URL', async () => {
    const r = await runIntake('not a url at all');
    if (!('stageFailed' in r)) throw new Error('expected fail');
    expect(r.stageNumber).toBe(1);
    expect(r.reason).toMatch(/malformed/i);
  });
  it('rejects localhost', async () => {
    const r = await runIntake('http://localhost:3000');
    if (!('stageFailed' in r)) throw new Error('expected fail');
    expect(r.stageNumber).toBe(1);
    expect(r.reason).toMatch(/private|localhost/i);
  });
  it('adds https when scheme missing', async () => {
    const r = await runIntake('example.com');
    if ('stageFailed' in r) throw new Error('expected pass');
    expect(r.canonicalUrl).toBe('https://example.com/');
  });
});

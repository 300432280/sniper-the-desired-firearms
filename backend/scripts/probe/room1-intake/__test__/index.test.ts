// backend/scripts/probe/room1-intake/__test__/index.test.ts
import { describe, it, expect } from 'vitest';
import { runRoom1 } from '../index';

describe('runRoom1', () => {
  it('returns IntakeState with canonicalUrl + runId for valid input', async () => {
    const r = await runRoom1('https://Example.COM/');
    if ('roomFailed' in r) throw new Error('expected pass');
    expect(r.canonicalUrl).toBe('https://example.com/');
    expect(r.runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(r.inputUrl).toBe('https://Example.COM/');
  });
  it('rejects malformed URL', async () => {
    const r = await runRoom1('not a url at all');
    if (!('roomFailed' in r)) throw new Error('expected fail');
    expect(r.roomNumber).toBe(1);
    expect(r.reason).toMatch(/malformed/i);
  });
  it('rejects localhost', async () => {
    const r = await runRoom1('http://localhost:3000');
    if (!('roomFailed' in r)) throw new Error('expected fail');
    expect(r.roomNumber).toBe(1);
    expect(r.reason).toMatch(/private|localhost/i);
  });
  it('adds https when scheme missing', async () => {
    const r = await runRoom1('example.com');
    if ('roomFailed' in r) throw new Error('expected pass');
    expect(r.canonicalUrl).toBe('https://example.com/');
  });
});

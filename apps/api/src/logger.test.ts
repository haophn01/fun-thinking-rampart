import { afterEach, describe, expect, it } from 'vitest';
import { CSRF_HEADER } from './contract';
import { REDACT_PATHS } from './logger';
import { createHarness, type Harness } from './testing/harness';

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});

type RequestLine = { msg?: string; req?: { headers?: Record<string, unknown> } };

describe('logger', () => {
  it('redacts x-csrf-token', async () => {
    const h = createHarness({ logLevel: 'info' });
    harnesses.push(h);
    const admin = await h.setupAdmin();
    const token = admin.csrfToken;
    expect(token).toEqual(expect.any(String));
    expect(token?.length).toBeGreaterThanOrEqual(16);

    // A write and a read on the session, both carrying the header the client always sends.
    const write = await admin.patch('/api/assessment', { type: 'c3pao' });
    expect(write.statusCode).toBe(200);
    const read = await admin.get('/api/session');
    expect(read.statusCode).toBe(200);
    // A refused write with a wrong token is logged too, and that value never shows either.
    const forged = 'f'.repeat(token?.length ?? 32);
    const refused = await admin.patch(
      '/api/assessment',
      { type: 'self' },
      {
        headers: { [CSRF_HEADER]: forged },
      },
    );
    expect(refused.statusCode).toBe(403);

    const incoming = (h.logs as RequestLine[]).filter((line) => line.msg === 'incoming request');
    const withHeader = incoming.filter((line) => line.req?.headers?.[CSRF_HEADER] !== undefined);
    // Setup is sent before the client has a token; every later request carries one.
    expect(withHeader.length).toBeGreaterThanOrEqual(3);
    for (const line of withHeader) expect(line.req?.headers?.[CSRF_HEADER]).toBe('[Redacted]');

    for (const line of h.logs) {
      const text = JSON.stringify(line);
      expect(text).not.toContain(token);
      expect(text).not.toContain(forged);
    }
    expect(REDACT_PATHS).toContain('req.headers["x-csrf-token"]');
  });
});

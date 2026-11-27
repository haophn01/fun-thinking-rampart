import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuditLog } from './AuditLog';

const TIMEOUT = { timeout: 15_000 };
const HASH = 'ab12'.repeat(16);
const VERIFIED_AT = '2026-11-27T09:30:00.000Z';

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status });
}

/** Every call is mocked. Verify calls wait for the test to answer them. */
function fakeApi() {
  const verifyCalls: ((response: Response) => void)[] = [];
  const paths: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string) => {
      paths.push(input);
      if (input.startsWith('/api/audit/verify')) {
        return new Promise<Response>((resolve) => {
          verifyCalls.push(resolve);
        });
      }
      if (input.startsWith('/api/audit')) {
        return Promise.resolve(json(200, { events: [], nextBefore: null }));
      }
      return Promise.resolve(json(404, { error: { code: 'not_found', message: 'nf' } }));
    }),
  );
  return {
    verifyPaths: () => paths.filter((p) => p.startsWith('/api/audit/verify')),
    /** Waits for the verify request number `index`, then answers it. */
    answer: async (index: number, response: Response) => {
      await waitFor(() => {
        expect(verifyCalls.length).toBeGreaterThan(index);
      }, TIMEOUT);
      verifyCalls[index]?.(response);
    },
    waitForRequest: (index: number) =>
      waitFor(() => {
        expect(verifyCalls.length).toBeGreaterThan(index);
      }, TIMEOUT),
  };
}

function okBody(total: number) {
  return {
    ok: true,
    checked: total,
    total,
    headHash: total === 0 ? null : HASH,
    firstBroken: null,
    verifiedAt: VERIFIED_AT,
  };
}

function brokenBody(problem: string, action: string, at: string, checked = 41) {
  return {
    ok: false,
    checked,
    total: 90,
    headHash: HASH,
    firstBroken: { id: 42, at, action, problem },
    verifiedAt: VERIFIED_AT,
  };
}

async function renderLog() {
  const api = fakeApi();
  render(<AuditLog />);
  await screen.findByText('No audit events yet.', undefined, TIMEOUT);
  return api;
}

const button = () => screen.getByRole('button', { name: /^Verify audit log$|^Verifying…$/ });
const ERROR_500 = () => json(500, { error: { code: 'internal', message: 'boom', requestId: 'r' } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AuditVerify', () => {
  it('sends nothing until clicked', async () => {
    const user = userEvent.setup();
    const api = await renderLog();
    expect(api.verifyPaths()).toEqual([]);
    expect(screen.queryByText('Audit log intact')).not.toBeInTheDocument();

    await user.click(button());
    await api.waitForRequest(0);
    expect(api.verifyPaths()).toEqual(['/api/audit/verify']);
    // While it runs: disabled, relabelled, with a polite line.
    expect(button()).toBeDisabled();
    expect(button()).toHaveTextContent('Verifying…');
    expect(screen.getByText("Checking every event's hash…")).toBeInTheDocument();
    await api.answer(0, json(200, okBody(2)));
    await screen.findByText('Audit log intact', undefined, TIMEOUT);
    expect(button()).toBeEnabled();
    expect(button()).toHaveTextContent('Verify audit log');
    expect(screen.queryByText("Checking every event's hash…")).not.toBeInTheDocument();
  }, 15_000);

  it('shows intact with the count and newest hash', async () => {
    const user = userEvent.setup();
    const api = await renderLog();
    const cases: [number, string][] = [
      [0, 'No events yet. Nothing to check.'],
      [1, 'The 1 event checks out.'],
      [1234, 'All 1,234 events check out.'],
    ];
    for (const [index, [total, text]] of cases.entries()) {
      await user.click(button());
      await api.answer(index, json(200, okBody(total)));
      await screen.findByText(text, undefined, TIMEOUT);
      const result = screen.getByText('Audit log intact').closest('[data-tone]') as HTMLElement;
      expect(result).toHaveAttribute('data-tone', 'info');
      const time = result.querySelector('time');
      expect(time).toHaveAttribute('dateTime', VERIFIED_AT);
      expect(time?.closest('p')).toHaveTextContent(
        `Checked ${new Date(VERIFIED_AT).toLocaleString()}`,
      );
      if (total === 0) {
        expect(within(result).queryByText('Newest hash')).not.toBeInTheDocument();
      } else {
        expect(within(result).getByText('Newest hash')).toBeInTheDocument();
        // The hash sits alone in its own element, set in the mono face by the module.
        const hash = within(result).getByText(HASH);
        expect(hash.className).toMatch(/hash/);
      }
    }
  }, 15_000);

  it('names the first broken event and its problem', async () => {
    const user = userEvent.setup();
    const api = await renderLog();
    const AT = '2026-11-24T10:03:00.000Z';
    const when = new Date(AT).toLocaleString();
    const cases: [string, string, string, string][] = [
      [
        'unchained',
        'objective_result.updated',
        'Objective result updated',
        'It has no hash: it was added outside Rampart.',
      ],
      [
        'prev_mismatch',
        'auth.signed_in',
        'Signed in',
        "Its link to the event before it doesn't match: an earlier event was changed or removed.",
      ],
      [
        'hash_mismatch',
        'made.up_action',
        'made.up_action',
        "Its contents don't match its hash: it was changed after it was written.",
      ],
    ];
    for (const [index, [problem, action, label, sentence]] of cases.entries()) {
      await user.click(button());
      await api.answer(index, json(200, brokenBody(problem, action, AT)));
      const title = await screen.findByText('Audit log broken', undefined, TIMEOUT);
      const alert = title.closest('[data-tone]') as HTMLElement;
      expect(alert).toHaveAttribute('data-tone', 'error');
      expect(alert).toHaveAttribute('role', 'alert');
      expect(alert).toHaveTextContent(`The chain breaks at event 42: ${label}, ${when}.`);
      expect(alert).toHaveTextContent(sentence);
      expect(alert).toHaveTextContent('41 events before it check out.');
    }
    // A raw `at` that is no date shows as is, markup stays text, and one event reads singular.
    await user.click(button());
    await api.answer(3, json(200, brokenBody('hash_mismatch', 'x<b>y</b>', 'not a date', 1)));
    await screen.findByText(/x<b>y<\/b>/, undefined, TIMEOUT);
    const alert = screen.getByText('Audit log broken').closest('[data-tone]');
    expect(alert).toHaveTextContent('The chain breaks at event 42: x<b>y</b>, not a date.');
    expect(alert).toHaveTextContent('1 event before it checks out.');
    expect(alert?.querySelector('b')).toBeNull();
  }, 15_000);

  it('shows an error with Retry, and the 429 wait', async () => {
    const user = userEvent.setup();
    const api = await renderLog();
    await user.click(button());
    await api.answer(0, ERROR_500());
    await screen.findByText("Couldn't verify the audit log.", undefined, TIMEOUT);
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await api.answer(
      1,
      json(429, {
        error: {
          code: 'too_many_attempts',
          message: 'slow',
          requestId: 'r',
          details: { retryAfterSeconds: 30 },
        },
      }),
    );
    expect(api.verifyPaths()).toHaveLength(2);
    await screen.findByText('Too many requests. Try again in 30 seconds.', undefined, TIMEOUT);
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await api.answer(2, json(200, okBody(3)));
    await screen.findByText('All 3 events check out.', undefined, TIMEOUT);
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  }, 15_000);

  it('only the newest answer is shown', async () => {
    const api = await renderLog();
    // The button is disabled while a check runs, so a second click can't come through the
    // page. The handler is still guarded: call the button's own onClick twice.
    const el = button();
    const propsKey = Object.keys(el).find((key) => key.startsWith('__reactProps'));
    const onClick = (el as unknown as Record<string, { onClick: () => void }>)[propsKey ?? '']
      ?.onClick;
    expect(onClick).toBeTypeOf('function');
    const { act } = await import('@testing-library/react');
    await act(async () => {
      onClick?.();
      await Promise.resolve();
    });
    await api.waitForRequest(0);
    await act(async () => {
      onClick?.();
      await Promise.resolve();
    });
    await api.waitForRequest(1);
    // The second answer lands first, the first one last.
    await api.answer(1, json(200, okBody(5)));
    await screen.findByText('All 5 events check out.', undefined, TIMEOUT);
    await api.answer(0, json(200, okBody(99)));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(screen.getByText('All 5 events check out.')).toBeInTheDocument();
    expect(screen.queryByText('All 99 events check out.')).not.toBeInTheDocument();
    expect(button()).toBeEnabled();
  }, 15_000);
});

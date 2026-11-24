import { PRODUCT_NAME } from '@rampart/api/contract';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('App', () => {
  it('mounts the shell with the product name and the Dashboard page', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(JSON.stringify({ status: 'ok', db: 'ok' })))),
    );
    render(<App />);
    expect(screen.getAllByText(PRODUCT_NAME).length).toBeGreaterThan(0);
    expect(screen.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeInTheDocument();
  });
});

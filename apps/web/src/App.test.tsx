import { PRODUCT_NAME } from '@rampart/api/contract';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from './App';

describe('App', () => {
  it('renders PRODUCT_NAME', () => {
    render(<App />);
    expect(screen.getByRole('heading', { level: 1, name: PRODUCT_NAME })).toBeInTheDocument();
  });
});

import { expect, test } from '@playwright/test';
import { loadCatalog } from '@rampart/catalog';
import { REGULATION } from '@rampart/rules/poam';
// The root has no dependency on the api; its browser-safe contract is the one spelling of the name.
import { PRODUCT_NAME } from '../apps/api/src/contract/index.ts';

test('fresh install shows Setup', async ({ page }) => {
  // The gate asks the session first; wait for that answer before reading the page.
  const session = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/api/session',
  );
  await page.goto('/');
  const sessionResponse = await session;
  expect(sessionResponse.ok()).toBe(true);
  expect(await sessionResponse.json()).toMatchObject({ setupRequired: true });

  await expect(
    page.getByRole('heading', { level: 1, name: `Set up ${PRODUCT_NAME}` }),
  ).toBeVisible();

  // The api answers through the web origin (Vite's proxy), not only on its own port.
  const viaWeb = await page.request.get('/api/health');
  expect(viaWeb.ok()).toBe(true);
  expect(await viaWeb.json()).toEqual({ status: 'ok', db: 'ok' });
});

test('workspace data is importable', () => {
  const catalog = loadCatalog();
  expect(catalog.requirements).toHaveLength(110);
  expect(catalog.requirements.flatMap((requirement) => requirement.objectives)).toHaveLength(320);
  expect(REGULATION.conditionalMinScore.value).toBeGreaterThan(0);
});

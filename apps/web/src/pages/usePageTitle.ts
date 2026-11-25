import { PRODUCT_NAME } from '@rampart/api/contract';
import { useLayoutEffect } from 'react';

/**
 * Sets `document.title` to `<Page> · <PRODUCT_NAME>`.
 *
 * A layout effect, so the title changes in the same commit that shows the page. A passive
 * effect runs in a later task, which leaves the old page's title up while the new page is
 * already on screen (and lets a quick route change land titles out of order).
 */
export function usePageTitle(page: string): void {
  useLayoutEffect(() => {
    document.title = `${page} · ${PRODUCT_NAME}`;
  }, [page]);
}

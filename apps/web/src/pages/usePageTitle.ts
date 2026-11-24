import { PRODUCT_NAME } from '@rampart/api/contract';
import { useEffect } from 'react';

/** Sets `document.title` to `<Page> · <PRODUCT_NAME>`. */
export function usePageTitle(page: string): void {
  useEffect(() => {
    document.title = `${page} · ${PRODUCT_NAME}`;
  }, [page]);
}

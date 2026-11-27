// Keep this import first: loading the contract makes zod jitless in the browser before any
// schema is built (here or in @rampart/catalog), so zod never probes eval under the page CSP.
import '@rampart/api/contract';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './look/fonts';
import './look/base.css';

const container = document.getElementById('root');
if (!container) throw new Error('index.html is missing the #root element');

// Each page sets document.title as `<Page> · <PRODUCT_NAME>` (pages/usePageTitle.ts).
createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

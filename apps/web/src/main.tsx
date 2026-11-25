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

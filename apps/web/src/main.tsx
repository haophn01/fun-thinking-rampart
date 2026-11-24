import { PRODUCT_NAME } from '@rampart/api/contract';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

const container = document.getElementById('root');
if (!container) throw new Error('index.html is missing the #root element');

document.title = PRODUCT_NAME;
createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

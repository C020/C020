import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { applyDocumentLang } from './i18n/core';
import './index.css';

// <html lang dir> before the first paint, from the language saved in this browser.
applyDocumentLang();

const container = document.getElementById('root');
if (!container) throw new Error('Root element #root is missing from index.html');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

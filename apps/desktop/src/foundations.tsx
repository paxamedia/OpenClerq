/**
 * Development page for the new interface's design system. Vite serves it at
 * /foundations.html; release builds take only index.html, so it never ships.
 */
import React from 'react';
import ReactDOM from 'react-dom/client';
import { Foundations } from '@clerq/web';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Foundations />
  </React.StrictMode>
);

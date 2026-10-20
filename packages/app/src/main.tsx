import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@xyflow/react/dist/style.css';
import './styles.css';
import './colorVars';
import './i18n';
import { App } from './App';
import { loadPacks } from './icons';
import { initMermaid } from './Preview';
import { applyTheme } from './theme';

applyTheme();
initMermaid();
void loadPacks();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

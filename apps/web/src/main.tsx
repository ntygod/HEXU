import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider } from './state.js';
import { App } from './App.js';
import './styles.css';
const root = document.getElementById('root');
if (!root) throw new Error('Missing root element');
createRoot(root).render(
  <StrictMode>
    <Provider>
      <App />
    </Provider>
  </StrictMode>,
);

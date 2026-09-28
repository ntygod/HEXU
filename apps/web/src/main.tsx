import { IdentityGate } from './identity.js';
import { AppearanceProvider } from './appearance.js';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider } from './state.js';
import { App } from './App.js';
import './foundation.css';
import { mountSpotlight } from './motion.js';
const root = document.getElementById('root');
if (!root) throw new Error('Missing root element');
mountSpotlight();
createRoot(root).render(
  <StrictMode>
    <AppearanceProvider>
      <IdentityGate>
        <Provider>
          <App />
        </Provider>
      </IdentityGate>
    </AppearanceProvider>
  </StrictMode>,
);

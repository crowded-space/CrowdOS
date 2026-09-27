import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import '@fontsource/outfit/400.css';
import '@fontsource/outfit/500.css';
import '@fontsource/outfit/600.css';
import '@fontsource/outfit/700.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/jetbrains-mono/600.css';
import {initTheme} from './config/theme';
import {installDesktopLogForwarder} from './config/desktop-log';
import {subscribeDesktopDeepLinks} from './config/deep-link';

initTheme();
// ponytail: desktop-only no-ops in browsers; must run before first render
// so boot errors and crowdos:// clicks land in logs/desktop.log / router.
installDesktopLogForwarder();
subscribeDesktopDeepLinks();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

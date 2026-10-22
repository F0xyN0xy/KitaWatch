import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './styles/globals.css';

if (import.meta.env.DEV && typeof performance !== 'undefined') {
  performance.mark('kitawatch:frontend-entry');
  const navigationStart = performance.getEntriesByType('navigation')[0]?.startTime ?? 0;
  console.debug(
    `[kitawatch][startup-timing] frontend entry reached in ${(performance.now() - navigationStart).toFixed(1)}ms`,
  );
  performance.mark('kitawatch:react-root-render-start');
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <BrowserRouter>
    <App />
  </BrowserRouter>,
);

if (import.meta.env.DEV && typeof performance !== 'undefined') {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const navigationStart = performance.getEntriesByType('navigation')[0]?.startTime ?? 0;
      console.debug(
        `[kitawatch][startup-timing] first render frame reached in ${(performance.now() - navigationStart).toFixed(1)}ms`,
      );
    });
  });
}

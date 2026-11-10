import { BRAND } from '@shared/brand';
import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { refuseStrayDrops } from './terminal/file-drop';
import { queryClient, TRPCProvider, trpcClient } from './trpc';
import './styles/theme.css';

document.title = BRAND.displayName;
// A first guess before the main process answers (ui/theme.ts), so nothing flashes.
document.documentElement.dataset.theme = matchMedia('(prefers-color-scheme: dark)').matches
  ? 'dark'
  : 'light';

// Files dropped anywhere but a terminal do nothing (spec §6.16).
refuseStrayDrops();

const root = document.getElementById('root');
if (!root) throw new Error('#root element missing from index.html');

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
        <App />
      </TRPCProvider>
    </QueryClientProvider>
  </StrictMode>,
);

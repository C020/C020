import { QueryClientProvider } from '@tanstack/react-query';
import { lazy, useEffect, useState } from 'react';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { onUnauthorized } from './api/client';
import { createQueryClient, installSessionHooks, keys } from './api/queries';
import { ConfirmHost } from './components/ConfirmHost';
import { Toaster } from './components/Toaster';
import { AuthGate } from './pages/AuthGate';
import { GuildLayout } from './pages/GuildLayout';
import { GuildPickerPage, HomeRedirect } from './pages/GuildPickerPage';
import { NotFoundPage, RouteErrorPage } from './pages/NotFoundPage';
import { OverviewPage } from './pages/OverviewPage';

const StreamersPage = lazy(() => import('./pages/streamers/StreamersPage'));
const SettingsPage = lazy(() => import('./pages/SettingsPage'));
const TemplatesPage = lazy(() => import('./pages/TemplatesPage'));
const HistoryPage = lazy(() => import('./pages/HistoryPage'));
const ActivityPage = lazy(() => import('./pages/ActivityPage'));
const SystemPage = lazy(() => import('./pages/SystemPage'));
const StandaloneSystemPage = lazy(() => import('./pages/SystemPage').then((m) => ({ default: m.StandaloneSystemPage })));

const router = createBrowserRouter([
  {
    path: '/',
    element: <AuthGate />,
    errorElement: <RouteErrorPage />,
    children: [
      { index: true, element: <HomeRedirect /> },
      { path: 'guilds', element: <GuildPickerPage /> },
      { path: 'system', element: <StandaloneSystemPage /> },
      {
        path: 'g/:guildId',
        element: <GuildLayout />,
        children: [
          { index: true, element: <OverviewPage /> },
          { path: 'streamers/:streamerId?', element: <StreamersPage /> },
          { path: 'settings', element: <SettingsPage /> },
          { path: 'templates', element: <TemplatesPage /> },
          { path: 'history', element: <HistoryPage /> },
          { path: 'activity', element: <ActivityPage /> },
          { path: 'system', element: <SystemPage /> },
          { path: '*', element: <NotFoundPage /> },
        ],
      },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);

export function App() {
  const [client] = useState(createQueryClient);

  useEffect(() => {
    installSessionHooks(client);
    // Any 401 means the session is gone: re-probe /api/me so the login screen takes over.
    return onUnauthorized(() => void client.invalidateQueries({ queryKey: keys.me }));
  }, [client]);

  return (
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
      <Toaster />
      <ConfirmHost />
    </QueryClientProvider>
  );
}

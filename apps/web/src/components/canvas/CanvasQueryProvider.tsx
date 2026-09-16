'use client';

import { useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Scoped to the /app/workflows/[id] route only — not an app-wide provider
// change. One QueryClient per mount (useState lazy-init, standard TanStack
// pattern) so client-side navigation between two different workflow pages
// doesn't share cached graph data across them.
export default function CanvasQueryProvider({ children }: { children: ReactNode }) {
  const [client] = useState(() => new QueryClient());
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

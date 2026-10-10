import type { Metadata } from 'next';
import { Suspense } from 'react';
import RequestAccessForm from '@/components/auth/RequestAccessForm';

export const metadata: Metadata = { title: 'Request access' };

export default function Page() {
  return (
    <Suspense>
      <RequestAccessForm />
    </Suspense>
  );
}

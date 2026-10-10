import type { Metadata } from 'next';
import { Suspense } from 'react';
import SignupForm from '@/components/auth/SignupForm';

export const metadata: Metadata = { title: 'Create account' };

export default function Page() {
  return (
    <Suspense>
      <SignupForm />
    </Suspense>
  );
}

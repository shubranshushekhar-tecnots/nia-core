import type { Metadata } from 'next';
import { Suspense } from 'react';
import LoginForm from '@/components/auth/LoginForm';

export const metadata: Metadata = { title: 'Sign in' };

export default function Page() {
  // Mirrors auth.ts's fail-safe default: unset/misconfigured SIGNUP_MODE
  // must read as gated ("request"), not open — "open" is the explicit
  // escape hatch.
  const requestMode = process.env.SIGNUP_MODE !== 'open';
  return (
    <Suspense>
      <LoginForm requestMode={requestMode} />
    </Suspense>
  );
}

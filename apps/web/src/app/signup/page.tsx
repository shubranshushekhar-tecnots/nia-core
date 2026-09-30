import { Suspense } from 'react';
import SignupForm from '@/components/auth/SignupForm';

export default function Page() {
  return (
    <Suspense>
      <SignupForm />
    </Suspense>
  );
}

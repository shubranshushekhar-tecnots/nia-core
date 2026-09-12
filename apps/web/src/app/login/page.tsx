import { Suspense } from 'react';
import LoginForm from '@/components/auth/LoginForm';

export default function Page() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}

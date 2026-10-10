import type { Metadata } from 'next';
import OnboardingForm from '@/components/auth/OnboardingForm';

export const metadata: Metadata = { title: 'Onboarding', robots: { index: false, follow: false } };

export default function Page() {
  return <OnboardingForm />;
}

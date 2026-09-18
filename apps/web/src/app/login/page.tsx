import { redirect } from 'next/navigation';
import { Wordmark } from '@/components/wordmark';
import { getSession } from '@/lib/session';
import { LoginForm } from './login-form';

export const metadata = { title: 'Sign in · MPS Dashboard' };

export default async function LoginPage() {
  const session = await getSession();
  if (session.userId) redirect('/');

  return (
    <main className="flex min-h-screen items-center justify-center bg-page px-6 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-7 flex justify-center">
          <Wordmark />
        </div>

        <div className="rounded-xl border border-line bg-surface p-6 shadow-[0_1px_2px_rgba(26,29,29,0.04)]">
          <h1 className="text-lg font-semibold tracking-tight">Sign in</h1>
          <p className="mt-1 mb-5 text-sm text-muted-foreground">
            Use your MPS Dashboard account.
          </p>
          <LoginForm />
        </div>

        <p className="mt-6 text-center text-xs text-muted-foreground">
          BGB – Elmdale Maintenance
        </p>
      </div>
    </main>
  );
}

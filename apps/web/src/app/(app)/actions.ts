'use server';

import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';

export async function signOut(): Promise<void> {
  const session = await getSession();
  session.destroy();
  redirect('/login');
}

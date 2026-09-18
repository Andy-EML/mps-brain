'use server';

import { redirect } from 'next/navigation';
import { authenticate } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { getSession } from '@/lib/session';

export interface LoginState {
  error?: string;
}

/** Deliberately the same message for every failure — never say which half was wrong. */
const FAILED = 'Incorrect username or password';

export async function login(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const username = String(formData.get('username') ?? '').trim();
  const password = String(formData.get('password') ?? '');

  if (!username || !password) return { error: FAILED };

  const user = await authenticate(getDb(), username, password);
  if (!user) return { error: FAILED };

  const session = await getSession();
  session.userId = user.id;
  session.username = user.username;
  session.role = user.role;
  await session.save();

  redirect('/');
}

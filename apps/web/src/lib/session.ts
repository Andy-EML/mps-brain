import { getIronSession, type SessionOptions } from 'iron-session';
import { cookies } from 'next/headers';
import { requiredEnv } from './env';

export interface SessionData {
  userId?: number;
  username?: string;
  role?: 'admin' | 'operator';
}

function sessionPassword(): string {
  const secret = requiredEnv('SESSION_SECRET');
  if (secret.length < 32) {
    throw new Error('SESSION_SECRET must be at least 32 characters long');
  }
  return secret;
}

function sessionOptions(): SessionOptions {
  return {
    password: sessionPassword(),
    cookieName: 'mps_session',
    cookieOptions: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 60 * 60 * 12,
      path: '/',
    },
  };
}

export async function getSession() {
  return getIronSession<SessionData>(await cookies(), sessionOptions());
}

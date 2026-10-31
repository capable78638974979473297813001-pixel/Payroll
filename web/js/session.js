import { api } from './api.js';

export const session = { user: null, config: null, company: null, ready: false };

export async function loadSession() {
  const [me, config] = await Promise.all([api.get('/v1/auth/me'), api.get('/v1/auth/config')]);
  session.user = me.user;
  session.config = config;
  session.ready = true;
  return session;
}

export async function refreshUser() {
  session.user = (await api.get('/v1/auth/me')).user;
  return session.user;
}

export async function signOut() {
  await api.post('/v1/auth/logout');
  session.user = null;
  session.company = null;
}

import { api } from './api.js';

export const session = { user: null, portal: null, config: null, company: null, ready: false };

export async function loadSession() {
  const [me, config] = await Promise.all([api.get('/v1/auth/me'), api.get('/v1/auth/config')]);
  session.user = me.user;
  session.portal = me.portal || null;
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

/** The employee login, if there is one: who it is, and whether the owner has approved it yet. */
export async function refreshPortal() {
  const me = await api.get('/v1/auth/me');
  session.user = me.user;
  session.portal = me.portal || null;
  return session.portal;
}

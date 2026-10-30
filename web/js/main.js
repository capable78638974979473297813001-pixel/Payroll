import { mount } from './dom.js';
import { route, setGuard, start } from './router.js';
import { loadSession, session } from './session.js';
import { landing } from './pages/landing.js';
import { signup, verify, login, nextPath } from './pages/auth.js';
import { industry, builder } from './pages/setup.js';
import { dashboardTab, helpPage } from './app/dashboard.js';
import { settingsPage } from './app/settings.js';
import { h } from './dom.js';

const root = document.getElementById('app');
mount(root, h('div', { class: 'loading-screen' }, h('div', { class: 'spinner', role: 'status', 'aria-label': 'Loading' })));

route('/', landing);
route('/signup', signup);
route('/signup/verify', verify);
route('/login', login);
route('/setup/industry', industry);
route('/setup/builder', builder);
route('/app/help', helpPage());
route('/app/settings', settingsPage());
route('/app', dashboardTab());
route('/app/:tab', dashboardTab());
route('/404', () => ({ title: 'Not found — Totali', el: h('div', { class: 'page-center' }, h('div', { class: 'card-plain stack' }, h('h1', { class: 't-heading-sm' }, 'Page not found.'), h('a', { href: '/' }, 'Back to Totali'))) }));

setGuard(async (ctx, pattern) => {
  const u = session.user;
  if (pattern === '/login' || pattern === '/signup') return u && u.emailVerified ? nextPath(u) : null;
  if (pattern === '/signup/verify') return !u ? '/signup' : u.emailVerified ? nextPath(u) : null;
  if (pattern.startsWith('/app')) return !u ? '/login' : !u.emailVerified ? '/signup/verify' : !u.companyId ? '/setup/industry' : null;
  if (pattern.startsWith('/setup')) return !u ? '/login' : !u.emailVerified ? '/signup/verify' : u.companyId ? '/app' : null;
  return null;
});

await loadSession();
await start(root);

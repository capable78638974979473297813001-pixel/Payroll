import { mount, h } from './dom.js';
import { route, setGuard, start } from './router.js';
import { loadSession, session } from './session.js';
import { landing } from './pages/landing.js';
import { signup, verify, login, forgot, nextPath } from './pages/auth.js';
import { industry, builder } from './pages/setup.js';
import { dashboardTab, helpPage } from './app/dashboard.js';
import { settingsPage } from './app/settings.js';
import { runPayrollPage, runPage, stubPage } from './app/payroll.js';
import { profilePage, peopleCards } from './app/people.js';
import { RENDERERS } from './widgets.js';
import { joinPage } from './pages/join.js';

Object.assign(RENDERERS, peopleCards);

const root = document.getElementById('app');
mount(root, h('div', { class: 'loading-screen' }, h('div', { class: 'spinner', role: 'status', 'aria-label': 'Loading' })));

route('/', landing);
route('/signup', signup);
route('/signup/verify', verify);
route('/login', login);
route('/forgot', forgot);
route('/setup/industry', industry);
route('/setup/builder', builder);
route('/app/help', helpPage());
route('/app/settings', settingsPage());
route('/join/:token', joinPage());
route('/app/people/:id', profilePage());
route('/app/payroll/run', runPayrollPage());
route('/app/payroll/runs/:id', runPage());
route('/app/payroll/runs/:id/stub/:eid', stubPage());
route('/app', dashboardTab());
route('/app/:tab', dashboardTab());
route('/404', () => ({ title: 'Not found — Totali', el: h('div', { class: 'auth', style: { display: 'block', textAlign: 'center', paddingTop: '120px' } }, h('h1', {}, 'Page not ', h('em', {}, 'found')), h('p', { style: { margin: '12px 0 24px', color: 'var(--mut)' } }, 'That page isn’t here.'), h('a', { class: 'btn', href: '/' }, 'Back to Totali')) }));

setGuard(async (ctx, pattern) => {
  const u = session.user;
  if (pattern === '/login' || pattern === '/signup' || pattern === '/forgot') return u && u.emailVerified ? nextPath(u) : null;
  if (pattern === '/signup/verify') return !u ? '/signup' : u.emailVerified ? nextPath(u) : null;
  if (pattern.startsWith('/app')) return !u ? '/login' : !u.emailVerified ? '/signup/verify' : !u.companyId ? '/setup/industry' : null;
  if (pattern.startsWith('/setup')) return !u ? '/login' : !u.emailVerified ? '/signup/verify' : u.companyId ? '/app' : null;
  return null;
});

await loadSession();
await start(root);

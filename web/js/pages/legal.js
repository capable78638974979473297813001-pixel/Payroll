import { h } from '../dom.js';
import { Logo } from '../ui.js';
import { link } from '../router.js';
import { TERMS, PRIVACY, EFFECTIVE, CONTACT } from './legal.content.js';

const block = (b) => (typeof b === 'string' ? h('p', {}, b) : h('ul', {}, ...b.list.map((x) => h('li', {}, x))));

function doc(title, other, sections) {
  const toc = h('nav', { class: 'legal-toc', 'aria-label': 'On this page' }, h('b', {}, 'On this page'), ...sections.map((s) => h('a', { href: `#${s.id}`, onClick: (e) => { e.preventDefault(); document.getElementById(s.id).scrollIntoView({ behavior: 'smooth', block: 'start' }); } }, s.title.replace(/^\d+\.\s*/, ''))));
  return { title: `${title} | Totali`, el: h('div', { class: 'legal' }, h('header', { class: 'authtop ui' }, Logo(), h('span', {}, link('/', { class: 'l2' }, 'Back to Totali'))),
    h('div', { class: 'legal-page ui' }, toc, h('main', { class: 'legal-body' },
      h('h1', {}, title), h('p', { class: 'legal-meta' }, `OMNIA TAX LLC · Effective ${EFFECTIVE}`),
      ...sections.flatMap((s) => [h('h2', { id: s.id }, s.title), ...s.blocks.map(block)]),
      h('p', { class: 'legal-foot' }, `Questions? ${CONTACT}. Also see our `, link(other[0], { class: 'link' }, other[1]), '.')))) };
}

export const terms = () => doc('Terms of Service', ['/privacy', 'Privacy Policy'], TERMS);
export const privacy = () => doc('Privacy Policy', ['/terms', 'Terms of Service'], PRIVACY);

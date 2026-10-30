// A company's saved theme becomes variables on the dashboard root. Nothing here is a template: each field is independent.
export const FONT_STACKS = {
  sans: '"Inter Tight", system-ui, -apple-system, "Segoe UI", sans-serif',
  grotesk: '"Helvetica Neue", Helvetica, Arial, sans-serif',
  humanist: 'Seravek, "Gill Sans Nova", Calibri, "Trebuchet MS", sans-serif',
  rounded: 'ui-rounded, "SF Pro Rounded", "Hiragino Maru Gothic ProN", Quicksand, system-ui, sans-serif',
  serif: '"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif',
  didone: 'Didot, "Bodoni 72", "Bodoni MT", "Playfair Display", Georgia, serif',
  slab: 'Rockwell, "Rockwell Nova", "Roboto Slab", Georgia, serif',
  mono: '"JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace',
};

const lin = (c) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
export function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}
export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
/** Black or white text, whichever reads better on this color. One of them is always at least 4.5 to 1. */
export function readableOn(hex) {
  return contrast(hex, '#ffffff') >= contrast(hex, '#0a0a0a') ? '#ffffff' : '#0a0a0a';
}

const SURFACES = { light: '#ffffff', paper: '#fffbf2', slate: '#f7f9fb', dark: '#1a1d24' };
/** Does the accent read well as text or numbers on the card color? Large numbers need 3 to 1. */
export function accentOnCard(theme) {
  return contrast(theme.accent, SURFACES[theme.mode] || '#ffffff');
}

export function applyTheme(root, theme, brand) {
  const s = root.style;
  root.dataset.mode = theme.mode;
  root.dataset.density = theme.density;
  root.dataset.cards = theme.cardStyle;
  root.dataset.nav = theme.nav;
  root.dataset.header = theme.header;
  root.dataset.numbers = theme.numbers;
  s.setProperty('--d-accent', theme.accent);
  s.setProperty('--d-accent-ink', readableOn(theme.accent));
  s.setProperty('--d-accent2', theme.accent2);
  s.setProperty('--d-radius', `${theme.radius}px`);
  s.setProperty('--d-font', FONT_STACKS[theme.font] || FONT_STACKS.sans);
  s.setProperty('--d-font-head', FONT_STACKS[theme.headingFont] || FONT_STACKS.sans);
  if (brand) document.title = `${brand.name} — Totali`;
}

/** The business's own words for things. `t('team')` is "Crew" if they renamed it. */
export function terms(config, defaults) {
  return (key) => (config.terms && config.terms[key]) || (defaults[key] && defaults[key].default) || key;
}

/** A few starting palettes, offered as swatches. They are colors, not templates: picking one changes only the accent. */
export const SWATCHES = ['#1f3bff', '#c2410c', '#0f766e', '#7c3aed', '#be123c', '#a16207', '#166534', '#0f172a', '#db2777', '#0369a1'];

/** Coherent combinations for "surprise me". Each is a set of independent values, not a saved design. */
export const LOOKS = [
  { mode: 'paper', accent: '#9f1239', accent2: '#2b1d0e', font: 'serif', headingFont: 'didone', radius: 2, density: 'airy', cardStyle: 'ruled', nav: 'top', header: 'plain', numbers: 'light' },
  { mode: 'dark', accent: '#d4a24c', accent2: '#f2e8d5', font: 'serif', headingFont: 'didone', radius: 0, density: 'comfortable', cardStyle: 'outlined', nav: 'side', header: 'plain', numbers: 'light' },
  { mode: 'light', accent: '#ea580c', accent2: '#0a0a0a', font: 'rounded', headingFont: 'rounded', radius: 16, density: 'comfortable', cardStyle: 'elevated', nav: 'top', header: 'band', numbers: 'bold' },
  { mode: 'slate', accent: '#0f766e', accent2: '#14212e', font: 'humanist', headingFont: 'humanist', radius: 8, density: 'compact', cardStyle: 'flat', nav: 'side', header: 'plain', numbers: 'mono' },
  { mode: 'dark', accent: '#22d3ee', accent2: '#f2f3f5', font: 'mono', headingFont: 'mono', radius: 0, density: 'compact', cardStyle: 'outlined', nav: 'top', header: 'plain', numbers: 'mono' },
  { mode: 'paper', accent: '#166534', accent2: '#2b1d0e', font: 'slab', headingFont: 'slab', radius: 4, density: 'comfortable', cardStyle: 'filled', nav: 'top', header: 'band', numbers: 'bold' },
  { mode: 'light', accent: '#7c3aed', accent2: '#0a0a0a', font: 'grotesk', headingFont: 'grotesk', radius: 24, density: 'airy', cardStyle: 'filled', nav: 'side', header: 'plain', numbers: 'bold' },
];

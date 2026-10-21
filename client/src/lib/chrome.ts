/** The browser's own colours (tab icon, mobile address bar) for each theme. index.html does the same before the app loads. */
const CHROME = {
  dark: { a: '#7C5CFF', b: '#FF5CA8', dot: '#22D3EE', bar: '#090C1A' },
  light: { a: '#14B8A6', b: '#3B82F6', dot: '#34D399', bar: '#F4F8FB' },
};

export function paintChrome(theme: 'light' | 'dark') {
  const c = CHROME[theme];
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', c.bar);
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'>` +
    `<stop offset='0' stop-color='${c.a}'/><stop offset='1' stop-color='${c.b}'/></linearGradient></defs>` +
    `<rect width='64' height='64' rx='18' fill='url(#g)'/>` +
    `<path d='M20 46 32 16l12 30M24.5 36h15' fill='none' stroke='white' stroke-width='6' stroke-linecap='round' stroke-linejoin='round'/>` +
    `<circle cx='49' cy='15' r='6' fill='${c.dot}'/></svg>`;
  const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (icon) icon.href = `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

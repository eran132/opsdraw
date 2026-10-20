import { paletteVars } from '@opsdraw/core';

/**
 * The `%% @style` palette as CSS custom properties on the app root, light and dark, from the same
 * table the SVG export uses, so the canvas and exports agree. Dark applies when the system asks
 * for it (unless the user picked light) or when the user picked dark (see theme.ts).
 */
const style = document.createElement('style');
style.dataset.opsdraw = 'palette';
style.textContent =
  `.app{${paletteVars('light')}}` +
  `@media (prefers-color-scheme: dark){:root:not([data-theme=light]) .app{${paletteVars('dark')}}}` +
  `:root[data-theme=dark] .app{${paletteVars('dark')}}`;
document.head.appendChild(style);

import { paletteVars } from '@opsdraw/core';

/**
 * The `%% @style` palette as CSS custom properties on the app root, light and dark, from the same
 * table the SVG export uses, so the canvas and exports agree.
 */
const style = document.createElement('style');
style.dataset.opsdraw = 'palette';
style.textContent =
  `.app{${paletteVars('light')}}` +
  `@media (prefers-color-scheme: dark){.app{${paletteVars('dark')}}}`;
document.head.appendChild(style);

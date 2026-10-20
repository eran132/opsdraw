// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const confPath = fileURLToPath(new URL('../../desktop/src-tauri/tauri.conf.json', import.meta.url));
const conf = JSON.parse(readFileSync(confPath, 'utf8'));
const main = conf.app.windows.find((w: { label: string }) => w.label === 'main');

describe('desktop shell config', () => {
  it('leaves HTML5 drag and drop to the page (palette drag onto the canvas)', () => {
    // Tauri's file-drop handler replaces WebView2's drag handling on Windows, which breaks
    // dragging icons from the palette onto the canvas.
    expect(main.dragDropEnabled).toBe(false);
  });

  it('opens at a size that fits common laptop screens', () => {
    expect(main.width).toBeLessThanOrEqual(1280);
    expect(main.height).toBeLessThanOrEqual(760);
  });

  it('keeps the strict content security policy', () => {
    expect(conf.app.security.csp).toContain("script-src 'self'");
    expect(conf.app.security.csp).not.toMatch(/script-src[^;]*unsafe/);
  });
});

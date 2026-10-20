import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LAYOUT,
  LIMITS,
  RAIL,
  STAGE_MIN,
  isOpen,
  parseLayout,
  resolveLayout,
  type PaneLayout,
} from '../src/panes';

const layout = (patch: Partial<PaneLayout> = {}): PaneLayout => ({ ...DEFAULT_LAYOUT, ...patch });

describe('parseLayout', () => {
  it('falls back to the defaults for missing or broken data', () => {
    expect(parseLayout(null)).toEqual(DEFAULT_LAYOUT);
    expect(parseLayout('{not json')).toEqual(DEFAULT_LAYOUT);
    expect(parseLayout('42')).toEqual(DEFAULT_LAYOUT);
  });

  it('keeps valid values, clamps sizes to their limits and drops the rest', () => {
    const parsed = parseLayout(
      JSON.stringify({
        sizes: { palette: 9999, editor: 300.4, inspector: 'wide', editorHeight: 10 },
        collapsed: { palette: true, editor: 'yes' },
        editorPosition: 'above',
        focus: true,
      }),
    );
    expect(parsed.sizes).toEqual({
      palette: LIMITS.palette.max,
      editor: 300,
      inspector: LIMITS.inspector.initial,
      editorHeight: LIMITS.editorHeight.min,
    });
    expect(parsed.collapsed).toEqual({ palette: true });
    expect(parsed.editorPosition).toBe('above');
    expect(parsed.focus).toBe(true);
    expect(parseLayout('{"editorPosition":"sideways"}').editorPosition).toBe('beside');
  });
});

describe('isOpen', () => {
  it('collapses the inspector by default in narrow windows only', () => {
    expect(isOpen(layout(), 'inspector', false)).toBe(true);
    expect(isOpen(layout(), 'inspector', true)).toBe(false);
    expect(isOpen(layout(), 'palette', true)).toBe(true);
    // An explicit choice wins over the narrow-window default.
    expect(isOpen(layout({ collapsed: { inspector: false } }), 'inspector', true)).toBe(true);
  });

  it('hides everything in focus mode', () => {
    for (const id of ['palette', 'editor', 'inspector'] as const)
      expect(isOpen(layout({ focus: true }), id, false)).toBe(false);
  });
});

describe('resolveLayout', () => {
  it('uses the stored sizes when they fit', () => {
    const r = resolveLayout(layout(), 1440, 800, false);
    expect(r.palette).toMatchObject({ open: true, size: 224 });
    expect(r.editor).toMatchObject({ open: true, size: 360 });
    expect(r.inspector).toMatchObject({ open: true, size: 256 });
    // The palette can grow to its own maximum here.
    expect(r.palette.max).toBe(LIMITS.palette.max);
    // The editor can grow until the stage is at its minimum (3 one-pixel dividers).
    expect(r.editor.max).toBe(1440 - 224 - 256 - 3 - STAGE_MIN.width);
  });

  it('squeezes the editor first, then the palette, so the stage keeps its minimum', () => {
    const r = resolveLayout(layout(), 1000, 700, false);
    const stage = 1000 - r.palette.size - r.editor.size - r.inspector.size - 3;
    expect(stage).toBe(STAGE_MIN.width);
    expect(r.palette.size).toBe(224);
    expect(r.editor.size).toBeLessThan(360);

    const tiny = resolveLayout(layout(), 700, 700, false);
    expect(tiny.editor.size).toBe(LIMITS.editor.min);
    expect(tiny.palette.size).toBeLessThan(224);
    expect(tiny.palette.size).toBeGreaterThanOrEqual(LIMITS.palette.min);
  });

  it('counts collapsed panels as rails', () => {
    const r = resolveLayout(layout({ collapsed: { inspector: true } }), 1440, 800, false);
    expect(r.inspector.open).toBe(false);
    expect(r.editor.max).toBe(1440 - 224 - RAIL - 3 - STAGE_MIN.width);
  });

  it('above the canvas, the editor takes height instead of width', () => {
    const r = resolveLayout(layout({ editorPosition: 'above' }), 1440, 800, false);
    expect(r.editorHeight.size).toBe(LIMITS.editorHeight.initial);
    expect(r.editorHeight.max).toBe(800 - 1 - STAGE_MIN.height);
    // Only the palette and inspector share the width with the stage.
    expect(r.palette.max).toBe(LIMITS.palette.max);
    const short = resolveLayout(
      layout({ editorPosition: 'above', sizes: { ...DEFAULT_LAYOUT.sizes, editorHeight: 700 } }),
      1440,
      500,
      false,
    );
    expect(short.editorHeight.size).toBe(500 - 1 - STAGE_MIN.height);
  });
});

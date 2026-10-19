import { describe, expect, it } from 'vitest';
import { alignRects, distributeRects, type Rect } from '../src/align';

const rects: Rect[] = [
  { id: 'a', x: 10, y: 40, w: 96, h: 88 },
  { id: 'b', x: 200, y: 0, w: 96, h: 88 },
  { id: 'c', x: 120, y: 300, w: 16, h: 16 },
];

describe('alignRects', () => {
  it('aligns left edges to the leftmost box', () => {
    const out = alignRects(rects, 'left');
    expect(Object.values(out).map((p) => p.x)).toEqual([10, 10, 10]);
    // The other axis is untouched.
    expect(out.b!.y).toBe(0);
  });

  it('aligns right edges to the rightmost box', () => {
    const out = alignRects(rects, 'right');
    expect(out.a!.x + 96).toBe(296);
    expect(out.b!.x + 96).toBe(296);
    expect(out.c!.x + 16).toBe(296);
  });

  it('centers on the middle of the combined bounds', () => {
    const out = alignRects(rects, 'center');
    // Bounds 10..296, center 153.
    expect(out.a!.x).toBe(105);
    expect(out.c!.x).toBe(145);
    const middle = alignRects(rects, 'middle');
    // Bounds 0..316, middle 158.
    expect(middle.a!.y).toBe(114);
    expect(middle.c!.y).toBe(150);
  });

  it('aligns top and bottom edges', () => {
    expect(Object.values(alignRects(rects, 'top')).map((p) => p.y)).toEqual([0, 0, 0]);
    const bottom = alignRects(rects, 'bottom');
    expect(bottom.a!.y + 88).toBe(316);
    expect(bottom.c!.y + 16).toBe(316);
  });

  it('returns nothing for no boxes', () => {
    expect(alignRects([], 'left')).toEqual({});
  });
});

describe('distributeRects', () => {
  it('makes the gaps between neighbours equal and keeps the outer boxes', () => {
    const row: Rect[] = [
      { id: 'a', x: 0, y: 0, w: 100, h: 10 },
      { id: 'c', x: 500, y: 0, w: 100, h: 10 },
      { id: 'b', x: 120, y: 5, w: 50, h: 10 },
    ];
    const out = distributeRects(row, 'horizontal');
    expect(out.a!.x).toBe(0);
    expect(out.c!.x).toBe(500);
    // Span 600, boxes 250, two gaps of 175.
    expect(out.b!.x).toBe(275);
    expect(out.b!.y).toBe(5);
  });

  it('distributes vertically', () => {
    const column: Rect[] = [
      { id: 'a', x: 0, y: 0, w: 10, h: 20 },
      { id: 'b', x: 0, y: 30, w: 10, h: 20 },
      { id: 'c', x: 0, y: 200, w: 10, h: 20 },
    ];
    expect(distributeRects(column, 'vertical').b!.y).toBe(100);
  });

  it('leaves fewer than three boxes alone', () => {
    const two = rects.slice(0, 2);
    expect(distributeRects(two, 'horizontal')).toEqual({
      a: { x: 10, y: 40 },
      b: { x: 200, y: 0 },
    });
  });
});

import { describe, expect, it } from 'vitest';
import {
  PNG_SOURCE_KEYWORD,
  absoluteRects,
  embedPngText,
  extractPngText,
  extractSvgSource,
  parseArchitecture,
  renderDiagramSvg,
  serializeArchitecture,
} from '../src';

const SRC = `---
title: Shop & "Payments" <prod>
---
architecture-beta
  group vpc(cloud)[VPC]
  service web(server)[Web front end with a long name] in vpc
  service db(database)[מסד נתונים] in vpc
  service q(lucide:list-ordered)[Queue]
  junction j
  web:R -[SQL & more]-> L:db
  web:B <--> T:q
  %% @pos vpc 0 0 400 200
  %% @pos web 24 48
  %% @pos db 240 48
  %% @pos q 40 300
`;

const diagram = parseArchitecture(SRC).diagram;
const icons = {
  server: { body: '<path d="M1 1h22v22H1z"/>', width: 24, height: 24 },
};

describe('SVG export from canvas geometry', () => {
  const svg = renderDiagramSvg(diagram, { resolveIcon: (r) => icons[r as 'server'] ?? null });

  it('uses stored positions, nested in their groups', () => {
    const rects = absoluteRects(diagram);
    expect(rects.get('db')).toMatchObject({ x: 240, y: 48, w: 96, h: 88 });
    expect(rects.get('vpc')).toMatchObject({ x: 0, y: 0, w: 400, h: 200 });
    // Unpositioned junction is still placed.
    expect(rects.get('j')).toBeDefined();
  });

  it('is well-formed XML with plain text, no foreignObject, and escaped content', () => {
    expect(svg).not.toContain('foreignObject');
    expect(svg).toContain(
      '<title id="opsdraw-title">Shop &amp; &quot;Payments&quot; &lt;prod&gt;</title>',
    );
    expect(svg).toContain('>SQL &amp; more</text>');
    expect(svg).toContain('marker-end="url(#opsdraw-arrow)"');
    expect(svg).toContain('marker-start="url(#opsdraw-arrow)"');
    // Missing icons get a placeholder instead of breaking the file.
    expect(svg).toMatch(/stroke-dasharray="3 2" class="icon"/);
    expect(svg.match(/<svg/g)).toHaveLength(1);
  });

  it('marks right-to-left labels and wraps long ones', () => {
    expect(svg).toMatch(/direction="rtl" unicode-bidi="embed">מסד נתונים<\/text>/);
    expect(svg).toContain('>Web front end</text>');
  });

  it('embeds the Mermaid source so the file can be reopened', () => {
    expect(extractSvgSource(svg)).toBe(serializeArchitecture(diagram));
    expect(extractSvgSource('<svg></svg>')).toBeNull();
    expect(renderDiagramSvg(diagram, { embedSource: false })).not.toContain('<metadata');
  });

  it('supports light, dark and automatic themes', () => {
    expect(renderDiagramSvg(diagram, { theme: 'auto' })).toContain('prefers-color-scheme: dark');
    expect(renderDiagramSvg(diagram, { theme: 'dark' })).toContain('--bg:#12151b');
  });
});

describe('PNG source embedding', () => {
  // A valid 1x1 PNG.
  const png = Uint8Array.from(
    atob(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    ),
    (c) => c.charCodeAt(0),
  );

  it('round-trips UTF-8 text', () => {
    const text = serializeArchitecture(diagram);
    const out = embedPngText(png, PNG_SOURCE_KEYWORD, text);
    expect(out.length).toBeGreaterThan(png.length);
    expect(extractPngText(out, PNG_SOURCE_KEYWORD)).toBe(text);
    expect(extractPngText(png, PNG_SOURCE_KEYWORD)).toBeNull();
    expect(extractPngText(out, 'other')).toBeNull();
  });

  it('rejects non-PNG input', () => {
    expect(() => embedPngText(new Uint8Array([1, 2, 3]), 'k', 'v')).toThrow(/PNG/);
    expect(extractPngText(new Uint8Array([1, 2, 3]), 'k')).toBeNull();
  });
});

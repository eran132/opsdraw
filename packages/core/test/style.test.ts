import { parse } from '@mermaid-js/parser';
import { describe, expect, it } from 'vitest';
import {
  findLineJumps,
  humanizeIcon,
  isRtlText,
  jumpPath,
  legendEntries,
  merge3,
  mergeLayout,
  parseArchitecture,
  parseStyleTokens,
  renderDiagramSvg,
  sanitizeColor,
  sanitizeStyle,
  serializeArchitecture,
} from '../src';

const STYLED = `architecture-beta
  group vpc(cloud)[VPC]
  group data(database)[Data tier]
  service web(server)[Web] in vpc
  service api(server)[API] in vpc
  service db(database)[Orders DB] in data
  junction j
  web:R --> L:api
  api:R --> L:db

  %% @layout opsdraw canvas positions (Mermaid ignores these lines)
  %% @pos vpc 0 0 400 200
  %% @pos data 480 0 200 200
  %% @pos web 24 48
  %% @pos api 200 48
  %% @pos db 40 48
  %% @style vpc stroke=blue fill=blue
  %% @style data fill=#FFAA00 color=#123
  %% @style db fill=green
  %% @style j fill=red
  %% @style ghost fill=red
`;

const parsed = () => parseArchitecture(STYLED).diagram;
const node = (d: ReturnType<typeof parsed>, id: string) => d.nodes.find((n) => n.id === id)!;

async function mermaidAccepts(text: string): Promise<string | null> {
  try {
    await parse('architecture', text);
    return null;
  } catch (e) {
    return String((e as Error).message);
  }
}

describe('%% @style', () => {
  it('parses colors onto nodes and normalizes hex', () => {
    const { diagram, errors } = parseArchitecture(STYLED);
    expect(errors).toEqual([]);
    expect(node(diagram, 'vpc').style).toEqual({ fill: 'blue', stroke: 'blue' });
    expect(node(diagram, 'data').style).toEqual({ fill: '#ffaa00', color: '#123' });
    expect(node(diagram, 'db').style).toEqual({ fill: 'green' });
    // Junctions have nothing to color; styles for unknown ids are dropped.
    expect(node(diagram, 'j').style).toBeUndefined();
    expect(diagram.comments).toEqual([]);
  });

  it('serializes sorted by id with sorted keys, and round-trips', () => {
    const text = serializeArchitecture(parsed());
    const lines = text.split('\n').filter((l) => l.includes('@style'));
    expect(lines).toEqual([
      '  %% @style data color=#123 fill=#ffaa00',
      '  %% @style db fill=green',
      '  %% @style vpc fill=blue stroke=blue',
    ]);
    expect(serializeArchitecture(parseArchitecture(text).diagram)).toBe(text);
  });

  it('writes a layout block for styles alone', () => {
    const text = serializeArchitecture({
      nodes: [{ id: 'a', kind: 'service', label: 'A', style: { fill: 'teal' } }],
      edges: [],
      layout: {},
      comments: [],
    });
    expect(text).toContain('%% @layout');
    expect(text).toContain('%% @style a fill=teal');
  });

  it('drops anything that is not a hex color or a palette name', () => {
    const attempts = [
      'fill=red;stroke:url(javascript:alert(1))',
      'fill="><script>alert(1)</script>',
      "fill=red'onload='x",
      'fill=url(#x)',
      'fill=rgb(1,2,3)',
      'fill=#12345',
      'fill=#gggggg',
      'fill=expression(alert(1))',
      'fill=var(--x)',
      'stroke=chartreuse',
      'onclick=red',
      'style=red',
      'fill',
      '=red',
    ];
    for (const a of attempts) expect(parseStyleTokens(a), a).toBeUndefined();
    expect(parseStyleTokens('fill=RED stroke=#AbC bogus=1')).toEqual({
      fill: 'red',
      stroke: '#abc',
    });
    expect(sanitizeColor(' Teal ')).toBe('teal');
    expect(sanitizeColor(42)).toBeUndefined();
    expect(sanitizeStyle({ fill: 'red', stroke: 'x;y', color: '#fff', extra: 'red' })).toEqual({
      fill: 'red',
      color: '#fff',
    });

    const d = parseArchitecture(
      `architecture-beta\n  service a(server)[A]\n  %% @style a fill="><script>alert(1)</script> stroke=red;fill:url(javascript:x)\n`,
    ).diagram;
    expect(d.nodes[0]!.style).toBeUndefined();
    expect(serializeArchitecture(d)).not.toContain('@style');
  });

  it('never lets an unsafe style reach an SVG export, even set in code', () => {
    const svg = renderDiagramSvg({
      nodes: [
        {
          id: 'a',
          kind: 'service',
          label: 'A',
          style: { fill: '"><script>alert(1)</script>', stroke: 'red;x:url(javascript:1)' },
        },
        { id: 'g', kind: 'group', label: 'G', style: { fill: 'url(javascript:1)', color: '#0f0' } },
      ],
      edges: [],
      layout: { a: { x: 0, y: 0 }, g: { x: 200, y: 0, w: 200, h: 120 } },
      comments: [],
    });
    expect(svg).not.toMatch(/script|javascript|url\(/i);
    expect(svg).toContain('style="fill:#0f0"');
  });

  it('is valid Mermaid', async () => {
    expect(await mermaidAccepts(serializeArchitecture(parsed()))).toBeNull();
    expect(await mermaidAccepts(STYLED)).toBeNull();
  });

  it('colors the SVG export, following the theme for palette names', () => {
    const light = renderDiagramSvg(parsed());
    expect(light).toContain('style="fill:rgba(37,99,235,0.10);stroke:#2563eb"');
    expect(light).toContain('style="fill:#ffaa00"');
    expect(light).toMatch(/class="group-label" text-anchor="start" style="fill:#123">Data tier/);
    const dark = renderDiagramSvg(parsed(), { theme: 'dark' });
    expect(dark).toContain('stroke:#60a5fa');
    const auto = renderDiagramSvg(parsed(), { theme: 'auto' });
    expect(auto).toContain('style="fill:var(--pal-blue-fill);stroke:var(--pal-blue-stroke)"');
    expect(auto).toContain('--pal-blue-fill:rgba(96,165,250,0.16)');
  });

  it('survives a re-import with mergeLayout', () => {
    const fresh = parseArchitecture(STYLED.replace(/ *%%.*\n/g, '')).diagram;
    expect(fresh.nodes.some((n) => n.style)).toBe(false);
    const { diagram, changed } = mergeLayout(parsed(), fresh);
    expect(node(diagram, 'vpc').style).toEqual({ fill: 'blue', stroke: 'blue' });
    expect(node(diagram, 'db').style).toEqual({ fill: 'green' });
    // Colors are not structure.
    expect(changed).toEqual([]);
  });

  describe('three-way merge', () => {
    const base = serializeArchitecture(parsed());
    const edit = (f: (d: ReturnType<typeof parsed>) => void) => {
      const d = parsed();
      f(d);
      return serializeArchitecture(d);
    };

    it('takes the side that changed a style, per key, without conflicts', () => {
      const ours = edit((d) => (node(d, 'vpc').style = { fill: 'red', stroke: 'blue' }));
      const theirs = edit((d) => {
        node(d, 'vpc').style = { fill: 'blue', stroke: 'blue', color: '#fff' };
        node(d, 'web').style = { fill: 'gray' };
        delete node(d, 'db').style;
      });
      const r = merge3(base, ours, theirs);
      expect(r.conflicts).toEqual([]);
      const m = parseArchitecture(r.text).diagram;
      expect(node(m, 'vpc').style).toEqual({ fill: 'red', stroke: 'blue', color: '#fff' });
      expect(node(m, 'web').style).toEqual({ fill: 'gray' });
      expect(node(m, 'db').style).toBeUndefined();
      expect(node(m, 'data').style).toEqual({ fill: '#ffaa00', color: '#123' });
    });

    it('keeps ours when both sides recolored the same key, still without a conflict', () => {
      const ours = edit((d) => (node(d, 'db').style = { fill: 'red' }));
      const theirs = edit((d) => (node(d, 'db').style = { fill: 'purple' }));
      const r = merge3(base, ours, theirs);
      expect(r.conflicts).toEqual([]);
      expect(node(parseArchitecture(r.text).diagram, 'db').style).toEqual({ fill: 'red' });
    });

    it('lets a deletion win over a color change', () => {
      const ours = edit((d) => (node(d, 'web').style = { fill: 'red' }));
      const theirs = edit((d) => {
        d.nodes = d.nodes.filter((n) => n.id !== 'web');
        d.edges = d.edges.filter((e) => e.from !== 'web');
      });
      const r = merge3(base, ours, theirs);
      expect(r.conflicts).toEqual([]);
      expect(r.text).not.toContain('web');
    });
  });
});

describe('legend', () => {
  const d = parseArchitecture(`architecture-beta
  group vpc(cloud)[VPC]
  group dmz(cloud)[DMZ]
  service a(server)[Alpha] in vpc
  service b(server)[Beta] in vpc
  service q(lucide:list-ordered)[Jobs] in dmz
  service c(database)[Gamma]
  %% @style vpc fill=blue stroke=blue
  %% @style dmz fill=blue stroke=blue
  %% @style c fill=#ff0000
`).diagram;

  it('lists icons (unique ones by node label) and colors by the groups that use them', () => {
    expect(legendEntries(d)).toEqual([
      { kind: 'icon', icon: 'cloud', label: 'Cloud' },
      { kind: 'icon', icon: 'server', label: 'Server' },
      { kind: 'icon', icon: 'lucide:list-ordered', label: 'Jobs' },
      { kind: 'icon', icon: 'database', label: 'Gamma' },
      { kind: 'color', style: { fill: 'blue', stroke: 'blue' }, label: 'VPC, DMZ' },
      { kind: 'color', style: { fill: '#ff0000' }, label: 'Gamma' },
    ]);
    expect(humanizeIcon('lucide:list-ordered')).toBe('List ordered');
    expect(humanizeIcon('aws:Arch_Amazon-EC2')).toBe('Arch Amazon EC2');
  });

  it('is drawn only when asked for, and grows the image', () => {
    const plain = renderDiagramSvg(d);
    expect(plain).not.toContain('class="legend"');
    const svg = renderDiagramSvg(d, { legend: true, legendTitle: 'מקרא' });
    expect(svg).toContain('class="legend"');
    expect(svg).toContain('>מקרא</text>');
    expect(svg).toContain('>VPC, DMZ</text>');
    expect(svg).toContain('>Cloud</text>');
    const h = (s: string) => Number(/height="([\d.]+)"/.exec(s)![1]);
    expect(h(svg)).toBeGreaterThan(h(plain));
  });

  it('is skipped for an empty diagram', () => {
    const svg = renderDiagramSvg(
      { nodes: [], edges: [], layout: {}, comments: [] },
      { legend: true },
    );
    expect(svg).not.toContain('class="legend"');
  });
});

describe('line jumps', () => {
  const H = [
    { x: 0, y: 50 },
    { x: 100, y: 50 },
  ];
  const V = [
    { x: 40, y: 0 },
    { x: 40, y: 100 },
  ];

  it('finds a crossing of a horizontal and a vertical segment of different edges', () => {
    expect(findLineJumps([H, V])).toEqual([{ edge: 0, segment: 0, x: 40, y: 50 }]);
    // Order of the edges does not matter: the hop is always on the horizontal one.
    expect(findLineJumps([V, H])).toEqual([{ edge: 1, segment: 0, x: 40, y: 50 }]);
  });

  it('ignores touching, T-junctions, shared ends, parallel lines and the same edge', () => {
    // Vertical ends on the horizontal line (T-junction).
    expect(
      findLineJumps([
        H,
        [
          { x: 40, y: 0 },
          { x: 40, y: 50 },
        ],
      ]),
    ).toEqual([]);
    // Vertical starts at the horizontal's end point.
    expect(
      findLineJumps([
        H,
        [
          { x: 100, y: 50 },
          { x: 100, y: 120 },
        ],
      ]),
    ).toEqual([]);
    // Too close to the end of the horizontal segment for a hop to fit.
    expect(
      findLineJumps([
        H,
        [
          { x: 95, y: 0 },
          { x: 95, y: 100 },
        ],
      ]),
    ).toEqual([]);
    // Misses: the vertical segment is above the horizontal one.
    expect(
      findLineJumps([
        H,
        [
          { x: 40, y: 0 },
          { x: 40, y: 30 },
        ],
      ]),
    ).toEqual([]);
    // Parallel.
    expect(
      findLineJumps([
        H,
        [
          { x: 0, y: 60 },
          { x: 100, y: 60 },
        ],
      ]),
    ).toEqual([]);
    // One edge crossing itself is not hopped.
    expect(
      findLineJumps([
        [
          { x: 0, y: 50 },
          { x: 100, y: 50 },
          { x: 100, y: 0 },
          { x: 40, y: 0 },
          { x: 40, y: 100 },
        ],
      ]),
    ).toEqual([]);
  });

  it('orders hops along the direction of travel and skips ones too close together', () => {
    const left = [
      { x: 200, y: 50 },
      { x: 0, y: 50 },
    ];
    const v = (x: number) => [
      { x, y: 0 },
      { x, y: 100 },
    ];
    expect(findLineJumps([left, v(40), v(120), v(44)]).map((j) => j.x)).toEqual([120, 44]);
  });

  it('draws upward semicircles in either direction', () => {
    const [j] = findLineJumps([H, V]);
    expect(jumpPath(H, [j!])).toBe('M0 50 L35 50 A5 5 0 0 1 45 50 L100 50');
    const back = [...H].reverse();
    const [k] = findLineJumps([back, V]);
    expect(jumpPath(back, [k!])).toBe('M100 50 L45 50 A5 5 0 0 0 35 50 L0 50');
  });

  it('adds hops to crossing edges in the SVG export', () => {
    const d = parseArchitecture(`architecture-beta
  service a(server)[A]
  service b(server)[B]
  service c(server)[C]
  service e(server)[E]
  a:R --> L:b
  c:B --> T:e
  %% @pos a 0 200
  %% @pos b 400 200
  %% @pos c 200 0
  %% @pos e 200 400
`).diagram;
    const svg = renderDiagramSvg(d);
    expect(svg).toMatch(/<path class="edge" d="M96 244 [^"]*A5 5 0 0 1 [^"]*"/);
    expect(renderDiagramSvg(d, { lineJumps: false })).not.toContain('A5 5');
  });
});

describe('bidi in exports', () => {
  it('picks the direction from the first strong character', () => {
    expect(isRtlText('שרת API')).toBe(true);
    expect(isRtlText('API שרת')).toBe(false);
    expect(isRtlText('123 خادم')).toBe(true);
    expect(isRtlText('')).toBe(false);
  });

  it('keeps right-to-left group titles inside the group', () => {
    const svg = renderDiagramSvg(
      parseArchitecture(
        `architecture-beta\n  group g(cloud)[רשת פרטית VPC]\n  %% @pos g 0 0 300 200\n`,
      ).diagram,
    );
    expect(svg).toMatch(
      /class="group-label" text-anchor="end" direction="rtl" unicode-bidi="embed">רשת פרטית VPC</,
    );
  });
});

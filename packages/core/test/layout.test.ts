import { parse } from '@mermaid-js/parser';
import { describe, expect, it } from 'vitest';
import {
  absoluteRects,
  anchor,
  assignPorts,
  autoLayout,
  lintDiagram,
  parseArchitecture,
  renderDiagramSvg,
  routePoints,
  serializeArchitecture,
  type Diagram,
} from '../src';

const read = (src: string) => {
  const { diagram, errors } = parseArchitecture(src);
  expect(errors).toEqual([]);
  return diagram;
};

const conflicts = (d: Diagram) => lintDiagram(d).filter((i) => i.code === 'port-conflict');

async function expectMermaidAccepts(d: Diagram) {
  const text = serializeArchitecture(d);
  await expect(parse('architecture', text)).resolves.toBeDefined();
  expect(parseArchitecture(text).errors).toEqual([]);
}

const WEB = `architecture-beta
  group cloud(cloud)[Cloud]
  group private(server)[Private network] in cloud
  service users(internet)[Users]
  service cdn(internet)[CDN]
  service lb(server)[Load balancer] in cloud
  service api(server)[API] in private
  service worker(server)[Worker] in private
  service queue(disk)[Jobs queue] in private
  service db(database)[Database] in private
  users:R --> L:cdn
  cdn:R --> L:lb
  lb:R --> L:api
  api:R -[enqueue]-> L:queue
  queue:B --> T:worker
  api:B --> T:db
  api:R --> L:worker
`;

const star = (n: number) => {
  const lines = ['architecture-beta', '  service api(server)[API]'];
  for (let i = 0; i < n; i++) lines.push(`  service s${i}(server)[S${i}]`, `  api:R --> L:s${i}`);
  return read(lines.join('\n'));
};

describe('assignPorts', () => {
  it('prefers the side facing the other node', () => {
    const d = read(`architecture-beta
  service a(server)[A]
  service b(server)[B]
  service c(server)[C]
  a:T -- T:b
  a:T -- T:c
  %% @pos a 0 0
  %% @pos b 300 0
  %% @pos c 0 300
`);
    const out = assignPorts(d);
    expect(out.edges.map((e) => `${e.fromSide}${e.toSide}`)).toEqual(['RL', 'BT']);
  });

  it('moves a second edge to the next best side instead of sharing one', () => {
    const d = read(`architecture-beta
  service lb(server)[LB]
  service a(server)[A]
  service b(server)[B]
  lb:R --> L:a
  lb:R --> L:b
  %% @pos lb 0 100
  %% @pos a 300 0
  %% @pos b 300 200
`);
    expect(conflicts(d)).toHaveLength(1);
    const out = assignPorts(d);
    expect(conflicts(out)).toEqual([]);
    // Both targets are to the right, one a bit up and one a bit down: one keeps R, the other
    // leaves through the side closest to it.
    const sides = out.edges.map((e) => e.fromSide).sort();
    expect(sides).toEqual(['B', 'R'].sort());
  });

  it('keeps fixed edges and ignores {group} ends', () => {
    const d = read(`architecture-beta
  group g(cloud)[G]
  service a(server)[A] in g
  service b(server)[B]
  service c(server)[C]
  a:R --> L:b
  a{group}:R --> L:c
  a:B --> T:c
  %% @pos g 0 0 200 200
  %% @pos a 24 40
  %% @pos b 400 40
  %% @pos c 400 300
`);
    const out = assignPorts(d, undefined, { fixed: (_, i) => i === 2 });
    expect(out.edges[2]).toMatchObject({ fromSide: 'B', toSide: 'T' });
    expect(out.edges[1]!.fromSide).toBe('R');
    expect(conflicts(out)).toEqual([]);
  });

  it('routes edges beyond four through a hub junction next to the node', async () => {
    const d = star(7);
    const laid = await autoLayout(d);
    expect(conflicts(laid)).toEqual([]);
    const hubs = laid.nodes.filter((n) => n.kind === 'junction').map((n) => n.id);
    expect(hubs[0]).toBe('api_hub');
    expect(hubs.every((h) => /^api_hub\d*$/.test(h))).toBe(true);
    // Every service is still connected, directly or through hubs, with its arrow.
    for (let i = 0; i < 7; i++) {
      const e = laid.edges.find((x) => x.to === `s${i}`)!;
      expect(e.arrowEnd).toBe(true);
      expect(e.from === 'api' || hubs.includes(e.from)).toBe(true);
    }
    const link = laid.edges.find((e) => e.from === 'api' && e.to === 'api_hub')!;
    expect(link.arrowEnd).toBeUndefined();
    await expectMermaidAccepts(laid);
  });

  it('is deterministic', async () => {
    const a = serializeArchitecture(await autoLayout(star(9)));
    const b = serializeArchitecture(await autoLayout(star(9)));
    expect(a).toBe(b);
  });
});

describe('autoLayout ports and routes', () => {
  it('leaves no port conflicts when no node has more than four edges', async () => {
    for (const d of [read(WEB), star(4)]) {
      const laid = await autoLayout(d);
      expect(conflicts(laid)).toEqual([]);
      expect(laid.nodes).toHaveLength(d.nodes.length);
      await expectMermaidAccepts(laid);
    }
  });

  it('stores orthogonal routes that start and end at the chosen sides', async () => {
    const laid = await autoLayout(read(WEB));
    const routed = laid.edges.filter((e) => e.route);
    expect(routed.length).toBeGreaterThan(0);
    const rects = absoluteRects(laid);
    for (const e of routed) {
      const p = anchor(rects.get(e.from)!, e.fromSide);
      const q = anchor(rects.get(e.to)!, e.toSide);
      const first = e.route![0]!;
      const last = e.route!.at(-1)!;
      // The first and last segments are perpendicular to the sides they attach to.
      if (p.dx) expect(Math.abs(first.y - p.y)).toBeLessThanOrEqual(1);
      else expect(Math.abs(first.x - p.x)).toBeLessThanOrEqual(1);
      if (q.dx) expect(Math.abs(last.y - q.y)).toBeLessThanOrEqual(1);
      else expect(Math.abs(last.x - q.x)).toBeLessThanOrEqual(1);
      // Every segment is horizontal or vertical.
      const pts = routePoints(p, e.fromSide, e.route!, q, e.toSide);
      for (let i = 1; i < pts.length; i++)
        expect(pts[i]!.x === pts[i - 1]!.x || pts[i]!.y === pts[i - 1]!.y).toBe(true);
    }
  });

  it('round-trips routes as sorted %% @route lines', async () => {
    const laid = await autoLayout(read(WEB));
    const text = serializeArchitecture(laid);
    const lines = text.split('\n').filter((l) => l.includes('%% @route'));
    expect(lines.length).toBe(laid.edges.filter((e) => e.route).length);
    expect([...lines].sort()).toEqual(lines);
    expect(lines[0]).toMatch(/^ {2}%% @route [a-z]+ [a-z]+( -?\d+,-?\d+)+$/);
    const again = read(text);
    expect(serializeArchitecture(again)).toBe(text);
    expect(again.edges.map((e) => e.route)).toEqual(
      laid.edges.map((e) => e.route?.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) }))),
    );
    await expect(parse('architecture', text)).resolves.toBeDefined();
  });

  it('drops routes for missing nodes or edges, and keeps them out of comments', () => {
    const d = read(`architecture-beta
  service a(server)[A]
  service b(server)[B]
  a:R --> L:b
  %% @route a b 10,20 30,20
  %% @route a gone 1,2
  %% @route b a 5,5
`);
    expect(d.edges[0]!.route).toEqual([
      { x: 10, y: 20 },
      { x: 30, y: 20 },
    ]);
    expect(d.comments).toEqual([]);
    expect(serializeArchitecture(d)).not.toMatch(/@route (a gone|b a)/);
  });

  it('draws the route in the exported SVG, and the plain elbow without one', async () => {
    const d = read(`architecture-beta
  service a(server)[A]
  service b(server)[B]
  a:R --> L:b
  %% @pos a 0 0
  %% @pos b 300 200
  %% @route a b 150,44 150,244
`);
    expect(renderDiagramSvg(d)).toContain('d="M96 44 L150 44 L150 244 L300 244"');
    const plain = renderDiagramSvg({ ...d, edges: d.edges.map(({ route: _r, ...e }) => e) });
    expect(plain).toContain('d="M96 44 L112 44 L198 44 L198 244 L284 244 L300 244"');
  });
});

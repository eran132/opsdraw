import { parse } from '@mermaid-js/parser';
import { describe, expect, it } from 'vitest';
import {
  GENERIC_CATALOG,
  assignPorts,
  catalogEntry,
  catalogKey,
  duplicateNodes,
  extractSubgraph,
  insertSubgraph,
  legendEntries,
  movedNodes,
  parseArchitecture,
  parseMermaid,
  repickMovedSides,
  serializeArchitecture,
  type Diagram,
} from '../src';

const read = (src: string) => {
  const { diagram, errors } = parseArchitecture(src);
  expect(errors).toEqual([]);
  return diagram;
};

async function expectMermaidAccepts(d: Diagram) {
  const text = serializeArchitecture(d);
  await expect(parse('architecture', text)).resolves.toBeDefined();
  expect(parseArchitecture(text).errors).toEqual([]);
}

const APP = `architecture-beta
  group vpc(cloud)[VPC]
  service web(server)[Web] in vpc
  service db(database)[DB] in vpc
  service users(lucide:users)[Users]
  users:R --> L:web
  web:R -[sql]-> L:db
  %% @pos vpc 200 0 400 200
  %% @pos web 24 48
  %% @pos db 240 48
  %% @pos users 0 48
  %% @style web fill=blue
  %% @route web db 140,100 260,100
`;

describe('extractSubgraph', () => {
  it('copies nodes, everything inside selected groups and the edges between them', () => {
    const frag = extractSubgraph(read(APP), ['vpc']);
    expect(frag.nodes.map((n) => n.id)).toEqual(['vpc', 'web', 'db']);
    expect(frag.edges).toEqual([
      { from: 'web', to: 'db', fromSide: 'R', toSide: 'L', label: 'sql', arrowEnd: true },
    ]);
    // Top-left at 0,0; children keep their positions inside the group.
    expect(frag.layout).toEqual({
      vpc: { x: 0, y: 0, w: 400, h: 200 },
      web: { x: 24, y: 48 },
      db: { x: 240, y: 48 },
    });
    expect(frag.nodes.find((n) => n.id === 'web')?.style).toEqual({ fill: 'blue' });
  });

  it('lifts nodes out of groups that are not copied, in absolute terms', () => {
    const frag = extractSubgraph(read(APP), ['web', 'users']);
    expect(frag.nodes.map((n) => [n.id, n.parent])).toEqual([
      ['web', undefined],
      ['users', undefined],
    ]);
    expect(frag.layout).toEqual({ web: { x: 224, y: 0 }, users: { x: 0, y: 0 } });
    expect(frag.edges.map((e) => `${e.from}->${e.to}`)).toEqual(['users->web']);
  });

  it('serializes to Mermaid that Mermaid accepts', async () => {
    const frag = extractSubgraph(read(APP), ['vpc', 'users']);
    await expectMermaidAccepts(frag);
    const text = serializeArchitecture(frag);
    expect(text).toContain('%% @pos vpc 200 0 400 200');
    expect(text).toContain('%% @pos users 0 48');
    expect(text).toContain('%% @style web fill=blue');
    expect(text).not.toContain('@route');
  });
});

describe('insertSubgraph', () => {
  it('renumbers colliding ids, re-maps edges and places the fragment at a point', async () => {
    const target = read(APP);
    const frag = extractSubgraph(target, ['vpc']);
    const { diagram, idMap, roots } = insertSubgraph(target, frag, { at: { x: 1000, y: 500 } });
    expect(idMap).toEqual({ vpc: 'vpc2', web: 'web2', db: 'db2' });
    expect(roots).toEqual(['vpc2']);
    expect(diagram.nodes.find((n) => n.id === 'web2')).toMatchObject({
      parent: 'vpc2',
      label: 'Web',
      style: { fill: 'blue' },
    });
    expect(diagram.layout.vpc2).toEqual({ x: 1000, y: 500, w: 400, h: 200 });
    expect(diagram.layout.web2).toEqual({ x: 24, y: 48 });
    expect(diagram.edges.at(-1)).toMatchObject({ from: 'web2', to: 'db2', label: 'sql' });
    expect(diagram.edges).toHaveLength(3);
    await expectMermaidAccepts(diagram);
  });

  it('pastes into a group, relative to it', () => {
    const target = read(APP);
    const frag = read(`architecture-beta
  service cache(lucide:zap)[Cache]
  %% @pos cache 50 50
`);
    const { diagram } = insertSubgraph(target, frag, { at: { x: 260, y: 100 }, parent: 'vpc' });
    expect(diagram.nodes.at(-1)).toMatchObject({ id: 'cache', parent: 'vpc' });
    expect(diagram.layout.cache).toEqual({ x: 60, y: 100 });
  });

  it('round-trips through clipboard text and accepts flowcharts', async () => {
    const target = read(APP);
    const text = serializeArchitecture(extractSubgraph(target, ['web', 'db']));
    const parsed = parseMermaid(text);
    expect(parsed.errors).toEqual([]);
    const { diagram } = insertSubgraph(target, parsed.diagram, { at: { x: 0, y: 400 } });
    expect(diagram.nodes.map((n) => n.id)).toContain('db2');

    const flow = parseMermaid('flowchart LR\n  A[Client] --> B[(Store)]\n');
    expect(flow.kind).toBe('flowchart');
    const pasted = insertSubgraph(target, flow.diagram, { at: { x: 0, y: 600 } });
    expect(pasted.roots).toHaveLength(2);
    for (const id of pasted.roots) expect(pasted.diagram.layout[id]).toBeDefined();
    await expectMermaidAccepts(pasted.diagram);
  });
});

describe('duplicateNodes', () => {
  it('copies a node next to the original, in the same parent', async () => {
    const d = read(APP);
    const { diagram, roots } = duplicateNodes(d, ['web']);
    expect(roots).toEqual(['web2']);
    expect(diagram.nodes.at(-1)).toEqual({
      id: 'web2',
      kind: 'service',
      label: 'Web',
      icon: 'server',
      parent: 'vpc',
      style: { fill: 'blue' },
    });
    expect(diagram.layout.web2).toEqual({ x: 48, y: 72 });
    // No edge has both ends in the copy.
    expect(diagram.edges).toHaveLength(d.edges.length);
    await expectMermaidAccepts(diagram);
  });

  it('puts a duplicated group beside the original instead of stacking it on top', () => {
    const d = read(APP);
    const { diagram } = duplicateNodes(d, ['vpc']);
    // vpc is at x=200 with width 400: the copy starts 24px after its right edge, same row.
    expect(diagram.layout.vpc2).toMatchObject({ x: 624, y: d.layout.vpc!.y });
    // A single service still gets the small diagonal nudge.
    expect(duplicateNodes(d, ['web']).diagram.layout.web2).toMatchObject({
      x: d.layout.web!.x + 24,
      y: d.layout.web!.y + 24,
    });
  });

  it('copies a group with its children and inner edges', async () => {
    const d = read(APP);
    const { diagram, roots, idMap } = duplicateNodes(d, ['vpc'], { x: 0, y: 240 });
    expect(roots).toEqual(['vpc2']);
    expect(idMap).toEqual({ vpc: 'vpc2', web: 'web2', db: 'db2' });
    expect(diagram.layout.vpc2).toEqual({ x: 200, y: 240, w: 400, h: 200 });
    expect(diagram.layout.db2).toEqual({ x: 240, y: 48 });
    const copy = diagram.edges.at(-1)!;
    expect(copy).toEqual({
      from: 'web2',
      to: 'db2',
      fromSide: 'R',
      toSide: 'L',
      label: 'sql',
      arrowEnd: true,
    });
    await expectMermaidAccepts(diagram);
  });

  it('keeps numbering when a copy of a copy is made', () => {
    const once = duplicateNodes(read(APP), ['users']).diagram;
    const twice = duplicateNodes(once, ['users']);
    expect(twice.roots).toEqual(['users3']);
    // A copy of the copy continues the numbering instead of appending to it.
    expect(duplicateNodes(twice.diagram, ['users2']).roots).toEqual(['users4']);
  });
});

describe('repickMovedSides', () => {
  const PAIR = `architecture-beta
  service api(server)[API]
  service queue(lucide:list-ordered)[Queue]
  service worker(server)[Worker]
  api:B -[enqueue]-> L:queue
  queue:R --> L:worker
  %% @pos api 0 0
  %% @pos queue 200 120
  %% @pos worker 400 120
  %% @route api queue 48,160
`;

  it('straightens the edge of two nodes lined up and drops its route', async () => {
    const prev = read(PAIR);
    const next = { ...prev, layout: { ...prev.layout, api: { x: 0, y: 120 } } };
    expect([...movedNodes(prev, next)]).toEqual(['api']);
    const out = repickMovedSides(prev, next);
    expect(out.edges[0]).toEqual({
      from: 'api',
      to: 'queue',
      fromSide: 'R',
      toSide: 'L',
      label: 'enqueue',
      arrowEnd: true,
    });
    // Edges without a moved end keep their sides.
    expect(out.edges[1]).toBe(prev.edges[1]);
    await expectMermaidAccepts(out);
  });

  it('respects sides other edges already use', () => {
    // queue's left side is taken by a fixed edge from elsewhere.
    const withOther = read(
      PAIR.replace('  api:B', '  service src(server)[Src]\n  src:R --> L:queue\n  api:B').replace(
        '%% @pos api 0 0',
        '%% @pos api 0 0\n  %% @pos src 0 400',
      ),
    );
    const next = { ...withOther, layout: { ...withOther.layout, api: { x: 0, y: 120 } } };
    const out = repickMovedSides(withOther, next);
    const e = out.edges.find((x) => x.from === 'api')!;
    expect(e.fromSide).toBe('R');
    expect(e.toSide).not.toBe('L');
  });

  it('re-picks when a group around an end moves', () => {
    const prev = read(`architecture-beta
  group g(cloud)[G]
  service a(server)[A] in g
  service b(server)[B]
  a:B --> T:b
  %% @pos g 0 0 200 200
  %% @pos a 24 48
  %% @pos b 24 400
`);
    const next = { ...prev, layout: { ...prev.layout, g: { x: -300, y: 352, w: 200, h: 200 } } };
    expect([...movedNodes(prev, next)].sort()).toEqual(['a', 'g']);
    const out = repickMovedSides(prev, next);
    expect(out.edges[0]).toMatchObject({ fromSide: 'R', toSide: 'L' });
  });

  it('adds no hubs and leaves nodes with more than four edges alone', () => {
    const many = read(`architecture-beta
  service hub(server)[Hub]
  service a(server)[A]
  service b(server)[B]
  service c(server)[C]
  service d(server)[D]
  service e(server)[E]
  hub:R --> L:a
  hub:B --> T:b
  hub:L --> R:c
  hub:T --> B:d
  e:T --> B:hub
  %% @pos hub 300 300
  %% @pos a 600 300
  %% @pos b 300 600
  %% @pos c 0 300
  %% @pos d 300 0
  %% @pos e 600 600
`);
    const next = { ...many, layout: { ...many.layout, hub: { x: 320, y: 300 } } };
    const out = repickMovedSides(many, next);
    expect(out.nodes).toHaveLength(many.nodes.length);
    expect(out.edges.map((e) => e.fromSide + e.toSide)).toEqual(
      many.edges.map((e) => e.fromSide + e.toSide),
    );
    // With hubs (the default) assignPorts would add one.
    expect(assignPorts(next).nodes.length).toBeGreaterThan(many.nodes.length);
  });

  it('leaves edits that moved nothing alone', () => {
    const prev = read(PAIR);
    const next = { ...prev, nodes: prev.nodes.map((n) => ({ ...n, label: 'x' })) };
    expect(repickMovedSides(prev, next)).toBe(next);
  });
});

describe('icon catalog', () => {
  it('gives every curated icon an English title', () => {
    const entries = GENERIC_CATALOG.flatMap((c) => c.icons);
    for (const e of entries) expect(e.title).toMatch(/^[A-Z]/);
    expect(new Set(entries.map((e) => catalogKey(e.ref))).size).toBe(entries.length);
    expect(catalogEntry('lucide:brick-wall')?.title).toBe('Firewall');
    expect(catalogEntry('lucide:split')?.title).toBe('Load balancer');
    expect(catalogEntry('lucide:not-curated')).toBeUndefined();
  });

  it('legends name shared curated icons by their title', () => {
    const d = read(`architecture-beta
  service a(lucide:split)[A]
  service b(lucide:split)[B]
`);
    expect(legendEntries(d)[0]).toMatchObject({ icon: 'lucide:split', label: 'Load balancer' });
  });
});

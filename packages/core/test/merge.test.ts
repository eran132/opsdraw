import { describe, expect, it } from 'vitest';
import {
  absoluteRects,
  autoLayout,
  diffStructure,
  dropStaleRoutes,
  lintDiagram,
  layoutNewNodes,
  mergeLayout,
  nodeChanges,
  parseArchitecture,
  serializeArchitecture,
  structurallyEqual,
  type Diagram,
} from '../src';

const parse = (src: string) => {
  const { diagram, errors } = parseArchitecture(src);
  expect(errors).toEqual([]);
  return diagram;
};

const PREVIOUS = parse(`---
title: Hand made
---
architecture-beta
  %% notes by a human
  group vpc(cloud)[VPC]
  service web(server)[Web] in vpc
  service db(database)[DB] in vpc
  service cache(lucide:zap)[Cache]

  web:B --> T:db
  web:L --> R:cache
  %% @pos vpc 500 400 300 260
  %% @pos web 30 50
  %% @pos db 30 160
  %% @pos cache 10 10
`);

const NEXT = parse(`architecture-beta
  group vpc(cloud)[VPC]
  service web(server)[Web frontend] in vpc
  service db(database)[DB] in vpc
  service cache(lucide:zap)[Cache] in vpc
  service queue(lucide:mail)[Queue] in vpc

  web:R --> L:db
  web:R --> L:queue
`);

describe('mergeLayout', () => {
  const result = mergeLayout(PREVIOUS, NEXT);

  it('keeps positions and group sizes for nodes with the same id and parent', () => {
    expect(result.diagram.layout.vpc).toEqual({ x: 500, y: 400, w: 300, h: 260 });
    expect(result.diagram.layout.web).toEqual({ x: 30, y: 50 });
    expect(result.diagram.layout.db).toEqual({ x: 30, y: 160 });
    expect(result.kept).toEqual(['db', 'vpc', 'web']);
  });

  it('drops the position of a node whose parent changed', () => {
    expect(result.diagram.layout.cache).toBeUndefined();
    expect(result.diagram.layout.queue).toBeUndefined();
  });

  it('keeps previous edge sides for the same from->to pair', () => {
    const e = result.diagram.edges.find((x) => x.from === 'web' && x.to === 'db')!;
    expect([e.fromSide, e.toSide]).toEqual(['B', 'T']);
    expect(result.keptEdges).toEqual(['web->db']);
  });

  it('reports structural differences', () => {
    expect(result.added).toEqual(['queue']);
    expect(result.removed).toEqual([]);
    expect(result.changed).toEqual(['cache', 'web']);
    expect(result.addedEdges).toEqual(['web->queue']);
    expect(result.removedEdges).toEqual(['web->cache']);
  });

  it('keeps the previous title and comments when the new diagram has none', () => {
    expect(result.diagram.title).toBe('Hand made');
    expect(result.diagram.comments).toEqual(['notes by a human']);
  });

  it('lists which node fields changed', () => {
    const web = (d: typeof PREVIOUS) => d.nodes.find((n) => n.id === 'web')!;
    expect(nodeChanges(web(PREVIOUS), web(NEXT))).toEqual(['label']);
  });
});

describe('structurallyEqual', () => {
  it('ignores layout, comments, edge sides and order', () => {
    const a = parse(`architecture-beta
  %% a comment
  service a(server)[A]
  service b(server)[B]
  a:R --> L:b
  %% @pos a 0 0
`);
    const b = parse(`architecture-beta
  service b(server)[B]
  service a(server)[A]
  a:B --> T:b
  %% @pos a 100 100
  %% @pos b 5 5
`);
    expect(structurallyEqual(a, b)).toBe(true);
  });

  it('notices labels, arrows and titles', () => {
    const a = parse(`architecture-beta
  service a(server)[A]
  service b(server)[B]
  a:R --> L:b
`);
    const b = parse(`architecture-beta
  service a(server)[A]
  service b(server)[B]
  a:R -- L:b
`);
    expect(structurallyEqual(a, b)).toBe(false);
    expect(diffStructure(a, b).changedEdges).toEqual(['a->b']);
    expect(structurallyEqual(a, { ...a, title: 'x' })).toBe(false);
  });
});

describe('layoutNewNodes', () => {
  it('places new nodes and leaves pinned ones where they were', async () => {
    const merged = mergeLayout(PREVIOUS, NEXT);
    const out = await layoutNewNodes(merged.diagram, new Set(merged.kept), {
      pinnedEdges: new Set(merged.keptEdges),
    });
    expect(out.layout.web).toEqual({ x: 30, y: 50 });
    expect(out.layout.db).toEqual({ x: 30, y: 160 });
    expect(out.layout.vpc).toMatchObject({ x: 500, y: 400 });
    for (const n of out.nodes) expect(out.layout[n.id]).toBeDefined();
    // queue connects to web, so it goes right of web; cache has no edges, so it goes at the
    // free end of the group, below the content. The pinned group grows to fit them.
    expect(out.layout.queue).toEqual({ x: 30 + 96 + 48, y: 50 });
    expect(out.layout.cache).toEqual({ x: 30, y: 160 + 88 + 48 });
    const vpc = out.layout.vpc!;
    expect(vpc).toMatchObject({ x: 500, y: 400, w: 300 });
    expect(vpc.h!).toBe(out.layout.cache!.y + 88 + 24);
    const kept = out.edges.find((e) => e.from === 'web' && e.to === 'db')!;
    expect([kept.fromSide, kept.toSide]).toEqual(['B', 'T']);
  });

  it('returns the diagram untouched when everything is pinned', async () => {
    const out = await layoutNewNodes(PREVIOUS, new Set(PREVIOUS.nodes.map((n) => n.id)));
    expect(out).toBe(PREVIOUS);
    expect(serializeArchitecture(out)).toBe(serializeArchitecture(PREVIOUS));
  });
});

const boxesOf = (d: Diagram) => {
  const rects = absoluteRects(d);
  return d.nodes.filter((n) => n.kind !== 'group').map((n) => ({ id: n.id, ...rects.get(n.id)! }));
};
const overlapping = (d: Diagram) => {
  const bs = boxesOf(d);
  const out: string[] = [];
  for (let i = 0; i < bs.length; i++)
    for (let j = i + 1; j < bs.length; j++) {
      const a = bs[i]!;
      const b = bs[j]!;
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h)
        out.push(`${a.id}/${b.id}`);
    }
  return out;
};

describe('layoutNewNodes (incremental)', () => {
  const BASE = parse(`architecture-beta
  group vpc(cloud)[VPC]
  service lb(server)[LB]
  service web(server)[Web] in vpc
  service db(database)[DB] in vpc
  lb:R --> L:web
  web:R --> L:db
  %% @pos lb 0 100
  %% @pos vpc 200 40 400 220
  %% @pos web 24 60
  %% @pos db 200 60
`);
  const grow = (extra: string) =>
    parse(serializeArchitecture(BASE).replace('\n  %% @layout', `${extra}\n  %% @layout`));

  it('puts a new node right of the neighbour it connects to, without overlaps', async () => {
    const d = grow(`  service cache(lucide:zap)[Cache] in vpc\n  db:R --> L:cache`);
    const out = await layoutNewNodes(d, new Set(Object.keys(BASE.layout)));
    for (const id of ['lb', 'web', 'db']) expect(out.layout[id]).toEqual(BASE.layout[id]);
    expect(out.layout.cache).toEqual({ x: 200 + 96 + 48, y: 60 });
    expect(overlapping(out)).toEqual([]);
    // The group grew to the right to fit it; it did not move.
    expect(out.layout.vpc).toEqual({ x: 200, y: 40, w: 200 + 96 + 48 + 96 + 24, h: 220 });
    expect(lintDiagram(out).filter((i) => i.code === 'port-conflict')).toEqual([]);
  });

  it('scans for a free spot when the preferred one is taken', async () => {
    const d = grow(`  service audit(server)[Audit] in vpc\n  web:R --> L:audit`);
    const out = await layoutNewNodes(d, new Set(Object.keys(BASE.layout)));
    // Right of web is where db is, so audit lands on the next free row.
    expect(out.layout.audit!.x).toBe(24 + 96 + 48);
    expect(out.layout.audit!.y).not.toBe(60);
    expect(overlapping(out)).toEqual([]);
    expect(lintDiagram(out).filter((i) => i.code === 'port-conflict')).toEqual([]);
  });

  it('lays out a new group around its children, next to what it connects to', async () => {
    const d = grow(
      `  group jobs(cloud)[Jobs]\n  service q(server)[Queue] in jobs\n  service w(server)[Worker] in jobs\n  q:R --> L:w\n  lb:B --> T:q`,
    );
    const out = await layoutNewNodes(d, new Set(Object.keys(BASE.layout)));
    const jobs = out.layout.jobs!;
    expect(out.layout.q).toEqual({ x: 24, y: 40 });
    expect(out.layout.w).toEqual({ x: 24 + 96 + 48, y: 40 });
    expect(jobs.w).toBe(24 + 96 + 48 + 96 + 24);
    expect(jobs.h).toBe(40 + 88 + 24);
    // At the root, right of lb (its neighbour) is taken by vpc, so it goes on a free spot.
    expect(overlapping(out)).toEqual([]);
    expect(jobs.x).toBeGreaterThanOrEqual(0 + 96 + 48);
  });

  it('is deterministic and keeps routes of edges whose ends did not move', async () => {
    const routed = parse(
      serializeArchitecture(BASE).replace(
        '%% @pos db 200 60',
        '%% @pos db 200 60\n  %% @route web db 160,104',
      ),
    );
    expect(routed.edges[1]!.route).toEqual([{ x: 160, y: 104 }]);
    const d = parse(
      serializeArchitecture(routed).replace(
        '\n  %% @layout',
        `  service x(server)[X]\n  lb:B --> T:x\n  %% @layout`,
      ),
    );
    const a = await layoutNewNodes(d, new Set(Object.keys(BASE.layout)), {
      pinnedEdges: new Set(['lb->web', 'web->db']),
    });
    const b = await layoutNewNodes(d, new Set(Object.keys(BASE.layout)), {
      pinnedEdges: new Set(['lb->web', 'web->db']),
    });
    expect(serializeArchitecture(a)).toBe(serializeArchitecture(b));
    expect(a.edges.find((e) => e.to === 'db')!.route).toEqual([{ x: 160, y: 104 }]);
    expect(serializeArchitecture(a)).toContain('%% @route web db 160,104');
  });

  it('falls back to a full layout when nothing is pinned', async () => {
    const d = parse(serializeArchitecture({ ...BASE, layout: {} }));
    const out = await layoutNewNodes(d, new Set());
    expect(serializeArchitecture(out)).toBe(serializeArchitecture(await autoLayout(d)));
  });
});

describe('mergeLayout with routes and hubs', () => {
  it('carries routes of kept edges, and drops them when an end moved', () => {
    const prev = parse(`architecture-beta
  service a(server)[A]
  service b(server)[B]
  service c(server)[C]
  a:R --> L:b
  b:R --> L:c
  %% @pos a 0 0
  %% @pos b 200 100
  %% @pos c 400 0
  %% @route a b 150,44 150,144
  %% @route b c 350,144 350,44
`);
    const next = parse(`architecture-beta
  group g(cloud)[G]
  service a(server)[A]
  service b(server)[B]
  service c(server)[C] in g
  a:R --> L:b
  b:R --> L:c
`);
    const m = mergeLayout(prev, next);
    expect(m.diagram.edges[0]!.route).toEqual([
      { x: 150, y: 44 },
      { x: 150, y: 144 },
    ]);
    // c changed parent, so its position (and the b->c route) is gone.
    expect(m.diagram.edges[1]!.route).toBeUndefined();
  });

  it('keeps fan-out hubs on re-import so the result is structurally unchanged', async () => {
    const src = ['architecture-beta', '  service api(server)[API]'];
    for (let i = 0; i < 7; i++) src.push(`  service s${i}(server)[S${i}]`, `  api:R --> L:s${i}`);
    const imported = parse(src.join('\n'));
    const laid = await autoLayout(imported);
    expect(laid.nodes.some((n) => n.id === 'api_hub')).toBe(true);
    const written = parse(serializeArchitecture(laid));

    const m = mergeLayout(written, imported);
    expect(diffStructure(written, m.diagram)).toMatchObject({
      added: [],
      removed: [],
      addedEdges: [],
      removedEdges: [],
    });
    expect(structurallyEqual(written, m.diagram)).toBe(true);
    expect(m.added).toEqual([]);
    expect(m.removed).toEqual([]);
    const again = await layoutNewNodes(m.diagram, new Set(m.kept), {
      pinnedEdges: new Set(m.keptEdges),
    });
    expect(serializeArchitecture(again)).toBe(serializeArchitecture(written));
  });
});

describe('dropStaleRoutes', () => {
  const d = parse(`architecture-beta
  group g(cloud)[G]
  service a(server)[A] in g
  service b(server)[B]
  service c(server)[C]
  a:R --> L:b
  b:R --> L:c
  %% @pos g 0 0 200 200
  %% @pos a 24 40
  %% @pos b 300 100
  %% @pos c 500 100
  %% @route a b 200,84 200,144
  %% @route b c 450,144 450,150 470,150 470,144
`);

  it('drops the routes of edges whose ends moved, also through their group', () => {
    const moved = dropStaleRoutes(d, {
      ...d,
      layout: { ...d.layout, g: { x: 10, y: 0, w: 200, h: 200 } },
    });
    expect(moved.edges[0]!.route).toBeUndefined();
    expect(moved.edges[1]!.route).toHaveLength(4);
    const c = dropStaleRoutes(d, { ...d, layout: { ...d.layout, c: { x: 520, y: 100 } } });
    expect(c.edges.map((e) => !!e.route)).toEqual([true, false]);
  });

  it('drops a route when the sides change, and returns the same object when nothing is stale', () => {
    const sides = {
      ...d,
      edges: d.edges.map((e, i) => (i ? { ...e, fromSide: 'B' as const } : e)),
    };
    expect(dropStaleRoutes(d, sides).edges.map((e) => !!e.route)).toEqual([true, false]);
    const same = { ...d, title: 'x' };
    expect(dropStaleRoutes(d, same)).toBe(same);
  });
});

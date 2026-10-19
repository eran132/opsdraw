import { describe, expect, it } from 'vitest';
import {
  diffStructure,
  layoutNewNodes,
  mergeLayout,
  nodeChanges,
  parseArchitecture,
  serializeArchitecture,
  structurallyEqual,
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
    // New nodes go below the pinned siblings, and the pinned group grows to fit them.
    expect(out.layout.queue!.y).toBeGreaterThanOrEqual(160 + 88);
    const vpc = out.layout.vpc!;
    expect(vpc.h!).toBeGreaterThanOrEqual(out.layout.queue!.y + 88);
    const kept = out.edges.find((e) => e.from === 'web' && e.to === 'db')!;
    expect([kept.fromSide, kept.toSide]).toEqual(['B', 'T']);
  });

  it('returns the diagram untouched when everything is pinned', async () => {
    const out = await layoutNewNodes(PREVIOUS, new Set(PREVIOUS.nodes.map((n) => n.id)));
    expect(out).toBe(PREVIOUS);
    expect(serializeArchitecture(out)).toBe(serializeArchitecture(PREVIOUS));
  });
});

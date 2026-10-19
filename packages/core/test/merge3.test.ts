import { describe, expect, it } from 'vitest';
import { annotateConflicts, merge3, parseArchitecture } from '../src';
import type { Diagram } from '../src';

const BASE = `---
title: Shop
---
architecture-beta
  %% hand notes
  group vpc(cloud)[VPC]
  service web(server)[Web] in vpc
  service db(database)[DB] in vpc
  service cache(disk)[Cache]

  web:B --> T:db
  web:L -[reads]- R:cache
  %% @pos vpc 100 100 400 300
  %% @pos web 20 40
  %% @pos db 20 160
  %% @pos cache 0 0
`;

const parse = (src: string): Diagram => {
  const { diagram, errors } = parseArchitecture(src);
  expect(errors).toEqual([]);
  return diagram;
};

/** Applies a series of literal line replacements, failing loudly if one does not match. */
function edit(src: string, ...pairs: [string, string][]): string {
  let out = src;
  for (const [from, to] of pairs) {
    expect(out, `edit target not found: ${from}`).toContain(from);
    out = out.replace(from, to);
  }
  return out;
}

const node = (d: Diagram, id: string) => d.nodes.find((n) => n.id === id);
const edge = (d: Diagram, from: string, to: string) =>
  d.edges.find((e) => e.from === from && e.to === to);

describe('merge3', () => {
  it('returns base unchanged-equivalent output when nothing changed', () => {
    const r = merge3(BASE, BASE, BASE);
    expect(r.conflicts).toEqual([]);
    expect(parse(r.text)).toEqual(parse(BASE));
  });

  it('unions independent node additions on both sides', () => {
    const ours = edit(BASE, [
      '  service cache',
      '  service api(server)[API] in vpc\n  service cache',
    ]);
    const theirs = edit(BASE, ['  service cache', '  service queue(disk)[Queue]\n  service cache']);
    const r = merge3(BASE, ours, theirs);
    expect(r.conflicts).toEqual([]);
    const d = parse(r.text);
    expect(node(d, 'api')).toMatchObject({ label: 'API', parent: 'vpc' });
    expect(node(d, 'queue')).toMatchObject({ label: 'Queue' });
    expect(d.nodes).toHaveLength(6);
  });

  it('takes each side’s moves when they move different nodes', () => {
    const ours = edit(BASE, ['@pos web 20 40', '@pos web 50 60']);
    const theirs = edit(BASE, ['@pos cache 0 0', '@pos cache 700 10']);
    const r = merge3(BASE, ours, theirs);
    expect(r.conflicts).toEqual([]);
    const d = parse(r.text);
    expect(d.layout.web).toEqual({ x: 50, y: 60 });
    expect(d.layout.cache).toEqual({ x: 700, y: 10 });
    expect(d.layout.db).toEqual({ x: 20, y: 160 });
  });

  it('prefers ours, without a conflict, when both move the same node', () => {
    const ours = edit(BASE, ['@pos web 20 40', '@pos web 50 60']);
    const theirs = edit(BASE, ['@pos web 20 40', '@pos web 90 90']);
    const r = merge3(BASE, ours, theirs);
    expect(r.conflicts).toEqual([]);
    expect(parse(r.text).layout.web).toEqual({ x: 50, y: 60 });
  });

  it('merges a group move and a group resize from different sides', () => {
    const ours = edit(BASE, ['@pos vpc 100 100 400 300', '@pos vpc 150 120 400 300']);
    const theirs = edit(BASE, ['@pos vpc 100 100 400 300', '@pos vpc 100 100 600 500']);
    const r = merge3(BASE, ours, theirs);
    expect(r.conflicts).toEqual([]);
    expect(parse(r.text).layout.vpc).toEqual({ x: 150, y: 120, w: 600, h: 500 });
  });

  it('applies a deletion when the other side did not change the node', () => {
    const ours = edit(
      BASE,
      ['  service cache(disk)[Cache]\n', ''],
      ['  web:L -[reads]- R:cache\n', ''],
      ['  %% @pos cache 0 0\n', ''],
    );
    const theirs = edit(BASE, ['@pos cache 0 0', '@pos cache 5 5']); // a move is not a change
    const r = merge3(BASE, ours, theirs);
    expect(r.conflicts).toEqual([]);
    const d = parse(r.text);
    expect(node(d, 'cache')).toBeUndefined();
    expect(edge(d, 'web', 'cache')).toBeUndefined();
    expect(d.layout.cache).toBeUndefined();
  });

  it('keeps a node deleted on one side but modified on the other, as a conflict', () => {
    const ours = edit(
      BASE,
      ['  service cache(disk)[Cache]\n', ''],
      ['  web:L -[reads]- R:cache\n', ''],
      ['  %% @pos cache 0 0\n', ''],
    );
    const theirs = edit(BASE, ['[Cache]', '[Redis]']);
    const r = merge3(BASE, ours, theirs);
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts[0]).toMatchObject({ kind: 'node', id: 'cache' });
    expect(r.conflicts[0]!.message).toMatch(/deleted in ours but changed in theirs/);
    const d = parse(r.text);
    expect(node(d, 'cache')).toMatchObject({ label: 'Redis' });
    // The edge was deleted by ours and untouched by theirs, so it stays deleted.
    expect(edge(d, 'web', 'cache')).toBeUndefined();
    expect(d.layout.cache).toEqual({ x: 0, y: 0 });
  });

  it('restores a deleted node that the other side added an edge to', () => {
    const ours = edit(
      BASE,
      ['  service cache(disk)[Cache]\n', ''],
      ['  web:L -[reads]- R:cache\n', ''],
      ['  %% @pos cache 0 0\n', ''],
    );
    const theirs = edit(BASE, ['  web:B --> T:db\n', '  web:B --> T:db\n  db:R --> L:cache\n']);
    const r = merge3(BASE, ours, theirs);
    expect(r.conflicts.map((c) => [c.kind, c.id])).toEqual([['node', 'cache']]);
    const d = parse(r.text);
    expect(node(d, 'cache')).toBeDefined();
    expect(edge(d, 'db', 'cache')).toBeDefined();
  });

  it('restores a deleted group the other side added a child to', () => {
    const ours = BASE.split('\n')
      .filter((l) => !/vpc|web|db/.test(l))
      .join('\n');
    const theirs = edit(BASE, [
      '  service cache',
      '  service api(server)[API] in vpc\n  service cache',
    ]);
    const r = merge3(BASE, ours, theirs);
    expect(r.conflicts.map((c) => [c.kind, c.id])).toEqual([['node', 'vpc']]);
    const d = parse(r.text);
    expect(node(d, 'vpc')).toBeDefined();
    expect(node(d, 'api')).toMatchObject({ parent: 'vpc' });
    expect(node(d, 'web')).toBeUndefined();
  });

  it('merges edits to different fields of the same node', () => {
    const ours = edit(BASE, ['service web(server)[Web]', 'service web(server)[Frontend]']);
    const theirs = edit(BASE, ['service web(server)[Web]', 'service web(lucide:globe)[Web]']);
    const r = merge3(BASE, ours, theirs);
    expect(r.conflicts).toEqual([]);
    expect(node(parse(r.text), 'web')).toMatchObject({ label: 'Frontend', icon: 'lucide:globe' });
  });

  it('reports conflicting label edits and keeps ours', () => {
    const ours = edit(BASE, ['[Web]', '[Frontend]'], ['-[reads]-', '-[gets]-']);
    const theirs = edit(BASE, ['[Web]', '[Portal]'], ['-[reads]-', '-[fetches]-']);
    const r = merge3(BASE, ours, theirs);
    expect(r.conflicts.map((c) => [c.kind, c.id, c.field])).toEqual([
      ['node', 'web', 'label'],
      ['edge', 'web->cache', 'label'],
    ]);
    expect(r.conflicts[0]!.message).toBe(
      'Node "web" label changed on both sides: ours "Frontend", theirs "Portal" (base "Web"); kept ours',
    );
    const d = parse(r.text);
    expect(node(d, 'web')!.label).toBe('Frontend');
    expect(edge(d, 'web', 'cache')!.label).toBe('gets');
  });

  it('does not conflict when both sides make the same change', () => {
    const ours = edit(BASE, ['[Web]', '[Frontend]']);
    const r = merge3(BASE, ours, ours);
    expect(r.conflicts).toEqual([]);
    expect(node(parse(r.text), 'web')!.label).toBe('Frontend');
  });

  it('unions edge additions and takes one-sided edge changes', () => {
    const ours = edit(BASE, ['  web:B --> T:db\n', '  web:B --> T:db\n  db:R --> L:cache\n']);
    const theirs = edit(BASE, [
      '  web:B --> T:db\n',
      '  web:B <--> T:db\n  cache:T -[sync]- B:db\n',
    ]);
    const r = merge3(BASE, ours, theirs);
    expect(r.conflicts).toEqual([]);
    const d = parse(r.text);
    expect(d.edges).toHaveLength(4);
    expect(edge(d, 'db', 'cache')).toBeDefined();
    expect(edge(d, 'cache', 'db')).toMatchObject({ label: 'sync' });
    expect(edge(d, 'web', 'db')).toMatchObject({ arrowStart: true, arrowEnd: true });
  });

  it('treats edge sides as layout (no conflict, ours wins)', () => {
    const ours = edit(BASE, ['web:B --> T:db', 'web:R --> L:db']);
    const theirs = edit(BASE, ['web:B --> T:db', 'web:T --> B:db']);
    const r = merge3(BASE, ours, theirs);
    expect(r.conflicts).toEqual([]);
    expect(edge(parse(r.text), 'web', 'db')).toMatchObject({ fromSide: 'R', toSide: 'L' });
  });

  it('deletes an edge removed on one side and conflicts when the other changed it', () => {
    const ours = edit(BASE, ['  web:B --> T:db\n', ''], ['  web:L -[reads]- R:cache\n', '']);
    const theirs = edit(BASE, ['-[reads]-', '-[queries]-']);
    const r = merge3(BASE, ours, theirs);
    expect(r.conflicts.map((c) => [c.kind, c.id])).toEqual([['edge', 'web->cache']]);
    const d = parse(r.text);
    expect(edge(d, 'web', 'db')).toBeUndefined();
    expect(edge(d, 'web', 'cache')).toMatchObject({ label: 'queries' });
  });

  it('keys parallel edges by label', () => {
    const base = edit(BASE, ['  web:B --> T:db\n', '  web:B --> T:db\n  web:R -[audit]-> L:db\n']);
    const ours = edit(base, ['  web:B --> T:db\n', '']);
    const theirs = edit(base, ['-[audit]->', '<-[audit]->']);
    const r = merge3(base, ours, theirs);
    expect(r.conflicts).toEqual([]);
    const d = parse(r.text);
    const between = d.edges.filter((e) => e.from === 'web' && e.to === 'db');
    expect(between).toEqual([
      expect.objectContaining({ label: 'audit', arrowStart: true, arrowEnd: true }),
    ]);
  });

  it('merges the title like a field', () => {
    const ours = edit(BASE, ['title: Shop', 'title: Store']);
    expect(merge3(BASE, ours, BASE).text).toMatch(/^---\ntitle: Store\n---/);
    const theirs = edit(BASE, ['title: Shop', 'title: Market']);
    const r = merge3(BASE, ours, theirs);
    expect(r.conflicts).toEqual([expect.objectContaining({ kind: 'title', field: 'title' })]);
    expect(parse(r.text).title).toBe('Store');
  });

  it('keeps comments added on both sides and honours removals', () => {
    const ours = edit(BASE, ['  %% hand notes\n', '  %% ours note\n']);
    const theirs = edit(BASE, ['  %% hand notes\n', '  %% hand notes\n  %% theirs note\n']);
    const r = merge3(BASE, ours, theirs);
    expect(parse(r.text).comments).toEqual(['ours note', 'theirs note']);
  });

  it('handles a node added on both sides with the same id', () => {
    const add = (label: string) =>
      edit(BASE, ['  service cache', `  service api(server)[${label}]\n  service cache`]);
    expect(merge3(BASE, add('API'), add('API')).conflicts).toEqual([]);
    const r = merge3(BASE, add('API'), add('Gateway'));
    expect(r.conflicts).toEqual([
      expect.objectContaining({ kind: 'node', id: 'api', field: 'label' }),
    ]);
    expect(r.conflicts[0]!.message).toMatch(/added on both sides/);
    expect(node(parse(r.text), 'api')!.label).toBe('API');
  });

  it('treats an empty base (add/add) as an empty diagram', () => {
    const r = merge3('', BASE, edit(BASE, ['@pos web 20 40', '@pos web 1 2']));
    expect(r.conflicts).toEqual([]);
    expect(parse(r.text).layout.web).toEqual({ x: 20, y: 40 });
  });

  it('returns ours unchanged with a parse conflict when an input does not parse', () => {
    const theirs = edit(BASE, ['  web:B --> T:db', '  web:B ==> T:db']);
    const r = merge3(BASE, BASE, theirs);
    expect(r.text).toBe(BASE);
    expect(r.conflicts).toEqual([expect.objectContaining({ kind: 'parse', side: 'theirs' })]);
    expect(r.conflicts[0]!.message).toMatch(/line \d+: Unrecognized statement/);
    expect(merge3('nope', BASE, BASE).conflicts[0]).toMatchObject({ kind: 'parse', side: 'base' });
  });

  it('is deterministic and symmetric for clean merges', () => {
    const ours = edit(BASE, ['@pos web 20 40', '@pos web 50 60'], ['[DB]', '[Postgres]']);
    const theirs = edit(BASE, ['  service cache', '  service queue(disk)[Queue]\n  service cache']);
    const a = merge3(BASE, ours, theirs);
    expect(merge3(BASE, ours, theirs).text).toBe(a.text);
    expect(parse(merge3(BASE, theirs, ours).text)).toEqual(
      expect.objectContaining({ layout: parse(a.text).layout, title: 'Shop' }),
    );
  });

  it('merges unknown %% @word layout lines by word and ids', () => {
    const base = `${BASE}  %% @hint web db 10 20 30 40\n`;
    const ours = edit(base, ['@hint web db 10 20 30 40', '@hint web db 11 21 31 41']);
    const theirs = `${edit(base, ['@pos cache 0 0', '@pos cache 9 9'])}  %% @hint web cache 1 2\n`;
    const r = merge3(base, ours, theirs);
    expect(r.conflicts).toEqual([]);
    expect(r.text).toContain('%% @hint web db 11 21 31 41');
    expect(r.text).toContain('%% @hint web cache 1 2');
    expect(r.text).not.toContain('@hint web db 10 20');
    expect(parse(r.text).layout.cache).toEqual({ x: 9, y: 9 });
  });

  it('merges edge routes as layout: one-sided changes apply, ours wins on both', () => {
    const base = edit(BASE, [
      '  %% @pos cache 0 0\n',
      '  %% @pos cache 0 0\n  %% @route web db 50,80 50,120\n  %% @route web cache 10,10 0,10\n',
    ]);
    const routeOf = (text: string, to: string) =>
      edge(parse(text), 'web', to)!.route?.map((p) => [p.x, p.y]);
    expect(routeOf(base, 'db')).toEqual([
      [50, 80],
      [50, 120],
    ]);
    const ours = edit(base, ['@route web db 50,80 50,120', '@route web db 60,80 60,120']);
    const theirs = edit(
      base,
      ['@route web db 50,80 50,120', '@route web db 70,80 70,120'],
      ['@route web cache 10,10 0,10', '@route web cache 5,5 0,5'],
    );
    const r = merge3(base, ours, theirs);
    expect(r.conflicts).toEqual([]);
    expect(routeOf(r.text, 'db')).toEqual([
      [60, 80],
      [60, 120],
    ]);
    expect(routeOf(r.text, 'cache')).toEqual([
      [5, 5],
      [0, 5],
    ]);
    // A route change alone does not block deleting the edge on the other side.
    const deleted = edit(
      base,
      ['  web:B --> T:db\n', ''],
      ['  %% @route web db 50,80 50,120\n', ''],
    );
    const d = merge3(base, deleted, theirs);
    expect(d.conflicts).toEqual([]);
    expect(edge(parse(d.text), 'web', 'db')).toBeUndefined();
    expect(d.text).not.toContain('@route web db');
  });

  it('drops unknown @ lines of deleted nodes', () => {
    const base = `${BASE}  %% @hint web cache 1 2\n`;
    const ours = edit(
      base,
      ['  service cache(disk)[Cache]\n', ''],
      ['  web:L -[reads]- R:cache\n', ''],
      ['  %% @pos cache 0 0\n', ''],
    );
    const r = merge3(base, ours, base);
    expect(r.conflicts).toEqual([]);
    expect(r.text).not.toContain('@hint web cache');
  });
});

describe('annotateConflicts', () => {
  it('adds %% CONFLICT lines after the header and the file still parses', () => {
    const ours = edit(BASE, ['[Web]', '[Frontend]']);
    const theirs = edit(BASE, ['[Web]', '[Portal]']);
    const r = merge3(BASE, ours, theirs);
    const text = annotateConflicts(r.text, r.conflicts);
    expect(text).toContain(
      'architecture-beta\n  %% CONFLICT: Node "web" label changed on both sides',
    );
    const d = parse(text);
    expect(d.comments.some((c) => c.startsWith('CONFLICT: '))).toBe(true);
    expect(annotateConflicts(r.text, [])).toBe(r.text);
  });
});

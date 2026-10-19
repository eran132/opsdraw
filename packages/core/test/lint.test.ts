import { describe, expect, it } from 'vitest';
import { levenshtein, lintDiagram, parseArchitecture, suggestIcons } from '../src';

const parse = (src: string) => {
  const { diagram, errors } = parseArchitecture(src);
  expect(errors).toEqual([]);
  return diagram;
};

const codes = (issues: { code: string }[]) => issues.map((i) => i.code).sort();

describe('lintDiagram', () => {
  it('reports nothing for a clean diagram with built-in icons', () => {
    const d = parse(`architecture-beta
  group vpc(cloud)[VPC]
  service web(server)[Web] in vpc
  service db(database)[DB] in vpc
  web:R --> L:db
`);
    expect(lintDiagram(d)).toEqual([]);
  });

  it('lists nodes whose icons GitHub cannot draw in one info issue', () => {
    const d = parse(`architecture-beta
  service a(lucide:cpu)[A]
  service b(aws:lambda)[B]
  service c(server)[C]
`);
    const issues = lintDiagram(d);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ severity: 'info', code: 'github-icons' });
    expect(issues[0]!.message).toContain('a, b');
    expect(issues[0]!.message).not.toContain('c,');
    expect(issues[0]!.message).toMatch(/opsdraw export/);
  });

  it('flags two edges on the same node side, with line numbers from the source', () => {
    const src = `architecture-beta
  service lb(server)[LB]
  service a(server)[A]
  service b(server)[B]
  lb:R --> L:a
  lb:R --> L:b
`;
    const issues = lintDiagram(parse(src), { source: src });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      severity: 'warning',
      code: 'port-conflict',
      nodeId: 'lb',
      line: 2,
    });
    expect(issues[0]!.message).toContain('lb:R -> L:a; lb:R -> L:b');
    expect(issues[0]!.message).toMatch(/junction/);
  });

  it('ignores {group} edge ends when checking sides', () => {
    const d = parse(`architecture-beta
  group g(cloud)[G]
  service a(server)[A] in g
  service b(server)[B]
  service c(server)[C]
  a{group}:R --> L:b
  a:R --> L:c
`);
    expect(codes(lintDiagram(d))).toEqual([]);
  });

  it('reports unknown icons with suggestions when knownIcons is given', () => {
    const d = parse(`architecture-beta
  service a(lucide:servr)[A]
  service b(databse)[B]
  service c(lucide:cpu)[C]
`);
    const known = new Set(['server', 'database', 'lucide:server', 'lucide:cpu']);
    const issues = lintDiagram(d, {
      knownIcons: (r) => known.has(r),
      iconCandidates: [...known],
    }).filter((i) => i.code === 'unknown-icon');
    expect(issues.map((i) => i.nodeId)).toEqual(['a', 'b']);
    expect(issues[0]!.message).toMatch(/did you mean lucide:server, server/);
    expect(issues[1]!.message).toMatch(/did you mean database/);
  });

  it('reports empty groups, and isolated services only in connected diagrams', () => {
    const small = parse(`architecture-beta
  group empty(cloud)[Empty]
  service a(server)[A]
  service lonely(server)[Lonely]
`);
    expect(codes(lintDiagram(small))).toEqual(['empty-group']);

    const big = parse(`architecture-beta
  service a(server)[A]
  service b(server)[B]
  service c(server)[C]
  service lonely(server)[Lonely]
  a:R --> L:b
  b:R --> L:c
  c:B --> T:a
`);
    const issues = lintDiagram(big);
    expect(issues).toEqual([
      expect.objectContaining({ code: 'isolated-node', severity: 'info', nodeId: 'lonely' }),
    ]);
  });
});

describe('suggestIcons', () => {
  it('prefers the same prefix and the closest names', () => {
    const c = ['server', 'lucide:server', 'lucide:server-cog', 'lucide:cpu', 'database'];
    expect(suggestIcons('lucide:servr', c, 2)).toEqual(['lucide:server', 'server']);
    expect(suggestIcons('servr', c, 1)).toEqual(['server']);
    expect(suggestIcons('zzzzzz', c)).toEqual([]);
  });

  it('treats containment as close', () => {
    expect(suggestIcons('lucide:serve', ['lucide:server-cog', 'lucide:x'], 3)).toEqual([
      'lucide:server-cog',
    ]);
  });

  it('computes edit distance', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3);
    expect(levenshtein('', 'abc')).toBe(3);
  });
});

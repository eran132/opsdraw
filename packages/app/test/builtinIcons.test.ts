import { describe, expect, it } from 'vitest';
import { emptyDiagram, type Diagram } from '@opsdraw/core';
import { builtinFor, isPrefixedIcon, toBuiltinIcons } from '../src/builtinIcons';

describe('builtinFor', () => {
  it.each([
    ['lucide:server', 'server'],
    ['lucide:server-cog', 'server'],
    ['lucide:cpu', 'server'],
    ['lucide:database', 'database'],
    ['lucide:database-zap', 'database'],
    ['lucide:hard-drive', 'disk'],
    ['lucide:archive', 'disk'],
    ['lucide:globe', 'internet'],
    ['lucide:waypoints', 'internet'],
    ['lucide:cloud', 'cloud'],
    ['lucide:cloud-upload', 'cloud'],
  ])('maps %s to %s', (ref, builtin) => {
    expect(builtinFor(ref)).toBe(builtin);
  });

  it.each(['lucide:users', 'lucide:split', 'lucide:cloud-rain', 'aws:ec2', 'server', undefined])(
    'leaves %s alone',
    (ref) => {
      expect(builtinFor(ref)).toBeNull();
    },
  );
});

describe('isPrefixedIcon', () => {
  it('tells pack icons from built-ins', () => {
    expect(isPrefixedIcon('lucide:users')).toBe(true);
    expect(isPrefixedIcon('aws:ec2')).toBe(true);
    expect(isPrefixedIcon('database')).toBe(false);
    expect(isPrefixedIcon(undefined)).toBe(false);
  });
});

describe('toBuiltinIcons', () => {
  const diagram: Diagram = {
    ...emptyDiagram(),
    nodes: [
      { id: 'net', kind: 'group', icon: 'lucide:cloud', label: 'Net' },
      { id: 'api', kind: 'service', icon: 'lucide:server', parent: 'net' },
      { id: 'users', kind: 'service', icon: 'lucide:users' },
      { id: 'ec2', kind: 'service', icon: 'aws:ec2' },
      { id: 'db', kind: 'service', icon: 'database' },
      { id: 'j', kind: 'junction' },
    ],
  };

  it('swaps what it can and keeps the rest', () => {
    const { diagram: out, changed } = toBuiltinIcons(diagram);
    expect(changed).toBe(2);
    expect(out.nodes.map((n) => n.icon)).toEqual([
      'cloud',
      'server',
      'lucide:users',
      'aws:ec2',
      'database',
      undefined,
    ]);
    expect(out.nodes[1]!.parent).toBe('net');
  });

  it('returns the same diagram when nothing maps', () => {
    const plain = { ...diagram, nodes: diagram.nodes.slice(2) };
    expect(toBuiltinIcons(plain).diagram).toBe(plain);
  });
});

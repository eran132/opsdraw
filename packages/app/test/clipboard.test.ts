import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArchitecture, type Diagram } from '@opsdraw/core';
import {
  clearMemoryClipboard,
  copySelection,
  copyText,
  cutSelection,
  duplicateSelection,
  parseFragment,
  pasteClipboard,
  selectionOf,
} from '../src/clipboard';

const read = (src: string): Diagram => {
  const { diagram, errors } = parseArchitecture(src);
  expect(errors).toEqual([]);
  return diagram;
};

const D = read(`architecture-beta
  group vpc(cloud)[VPC]
  service web(server)[Web] in vpc
  service db(database)[DB] in vpc
  web:R --> L:db
  %% @pos vpc 100 100 400 200
  %% @pos web 24 48
  %% @pos db 240 48
`);

const noPointer = { pointer: null, fallback: { x: 0, y: 0 }, groupAt: () => undefined };

/** A system clipboard that works, or one that throws like a blocked one. */
function mockClipboard(blocked: boolean) {
  let text = '';
  const clipboard = {
    writeText: vi.fn(async (t: string) => {
      if (blocked) throw new Error('blocked');
      text = t;
    }),
    readText: vi.fn(async () => {
      if (blocked) throw new Error('blocked');
      return text;
    }),
  };
  Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true });
  return clipboard;
}

afterEach(() => {
  clearMemoryClipboard();
});

describe('selectionOf', () => {
  it('turns ids into a canvas selection', () => {
    expect(selectionOf([])).toBeNull();
    expect(selectionOf(['a'])).toEqual({ type: 'node', id: 'a' });
    expect(selectionOf(['a', 'b'])).toEqual({ type: 'nodes', ids: ['a', 'b'] });
  });
});

describe('duplicateSelection', () => {
  it('copies and selects the copies', () => {
    const out = duplicateSelection(D, ['web', 'db']);
    expect(out.selection).toEqual({ type: 'nodes', ids: ['web2', 'db2'] });
    expect(out.diagram.edges.at(-1)).toMatchObject({ from: 'web2', to: 'db2' });
    expect(out.diagram.layout.web2).toEqual({ x: 48, y: 72 });
  });
});

describe('clipboard', () => {
  it('writes Mermaid text that parses back into a fragment', () => {
    const text = copyText(D, ['vpc'])!;
    expect(text).toContain('architecture-beta');
    expect(text).toContain('%% @pos vpc 0 0 400 200');
    expect(parseFragment(text)?.nodes.map((n) => n.id)).toEqual(['vpc', 'web', 'db']);
    expect(copyText(D, [])).toBeNull();
    expect(parseFragment('just some words')).toBeNull();
  });

  it('pastes from the system clipboard next to the originals, then further along', async () => {
    const clip = mockClipboard(false);
    await copySelection(D, ['web']);
    expect(clip.writeText).toHaveBeenCalledOnce();
    const first = (await pasteClipboard(D, noPointer))!;
    expect(first.selection).toEqual({ type: 'node', id: 'web2' });
    // web is at 124,148 in absolute terms; the paste lands 24px down and right, at top level.
    expect(first.diagram.layout.web2).toEqual({ x: 148, y: 172 });
    const second = (await pasteClipboard(first.diagram, noPointer))!;
    expect(second.diagram.layout.web3).toEqual({ x: 172, y: 196 });
  });

  it('pastes at the pointer, into the group under it', async () => {
    mockClipboard(false);
    await copySelection(D, ['db']);
    const out = (await pasteClipboard(D, {
      pointer: { x: 150, y: 250 },
      fallback: { x: 0, y: 0 },
      groupAt: () => 'vpc',
    }))!;
    expect(out.diagram.nodes.at(-1)).toMatchObject({ id: 'db2', parent: 'vpc' });
    expect(out.diagram.layout.db2).toEqual({ x: 50, y: 150 });
  });

  it('falls back to an in-memory copy when the clipboard is blocked', async () => {
    mockClipboard(true);
    const cut = (await cutSelection(D, ['web']))!;
    expect(cut.nodes.map((n) => n.id)).toEqual(['vpc', 'db']);
    expect(cut.edges).toEqual([]);
    const out = (await pasteClipboard(cut, noPointer))!;
    // The id is free again, so the node comes back as itself (its edge is not part of the copy).
    expect(out.selection).toEqual({ type: 'node', id: 'web' });
  });

  it('pastes Mermaid copied elsewhere, flowcharts included, and ignores other text', async () => {
    const clip = mockClipboard(false);
    await clip.writeText('flowchart LR\n  a[Client] --> b[Server]\n');
    const out = (await pasteClipboard(D, { ...noPointer, fallback: { x: 600, y: 0 } }))!;
    expect(out.selection).toEqual({ type: 'nodes', ids: ['a', 'b'] });
    expect(out.diagram.edges.at(-1)).toMatchObject({ from: 'a', to: 'b' });
    await clip.writeText('hello');
    expect(await pasteClipboard(D, noPointer)).toBeNull();
  });
});

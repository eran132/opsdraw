import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  ConnectionMode,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  applyNodeChanges,
  useReactFlow,
  type Connection,
  type Edge,
  type NodeChange,
  type OnSelectionChangeParams,
} from '@xyflow/react';
import {
  SERVICE_SIZE,
  JUNCTION_SIZE,
  descendantsOf,
  makeId,
  removeNode,
  sidesFor,
  type ArchNode,
  type Diagram,
  type NodeLayout,
  type Side,
} from '@opsdraw/core';
import { CanvasActionsContext, nodeTypes, type ArchFlowNode } from './nodes';

export type Selection =
  | { type: 'node'; id: string }
  | { type: 'nodes'; ids: string[] }
  | { type: 'edge'; index: number }
  | null;

/** Ids of the selected nodes, whatever the kind of selection. */
export const selectedNodeIds = (s: Selection): string[] =>
  s?.type === 'node' ? [s.id] : s?.type === 'nodes' ? s.ids : [];

/** Diagrams bigger than this only draw what is in view. */
export const LARGE_DIAGRAM = 200;

const NUDGE_COMMIT_MS = 400;
const ARROWS: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

/** What the palette puts on the drag payload. */
export interface PaletteItem {
  kind: ArchNode['kind'];
  icon?: string;
  label: string;
}

export const DRAG_MIME = 'application/x-opsdraw';

const GROUP_DEFAULT = { w: 320, h: 220 };

interface Props {
  diagram: Diagram;
  onChange(d: Diagram): void;
  selection: Selection;
  onSelect(s: Selection): void;
  /** Changes when a new document is loaded, to re-fit the view. */
  fitKey: number;
  onEditLabel(): void;
}

function depthOf(d: Diagram, n: ArchNode, byId?: Map<string, ArchNode>): number {
  const find = (id: string) => byId?.get(id) ?? d.nodes.find((x) => x.id === id);
  let depth = 0;
  for (let p = n.parent; p && depth < 64; p = find(p)?.parent) depth++;
  return depth;
}

function toFlowNodes(d: Diagram, selected: ReadonlySet<string>): ArchFlowNode[] {
  const fallbackIndex = new Map<string | undefined, number>();
  const byId = new Map(d.nodes.map((n) => [n.id, n]));
  const depth = new Map(d.nodes.map((n) => [n.id, depthOf(d, n, byId)]));
  // Parents must come before children for the canvas to nest them.
  const ordered = [...d.nodes].sort((a, b) => depth.get(a.id)! - depth.get(b.id)!);
  return ordered.map((n) => {
    let l = d.layout[n.id];
    if (!l) {
      // Not positioned yet (typed in the editor): place on a simple grid inside the parent.
      const i = fallbackIndex.get(n.parent) ?? 0;
      fallbackIndex.set(n.parent, i + 1);
      l = { x: 24 + (i % 4) * 128, y: 48 + Math.floor(i / 4) * 120 };
    }
    const node: ArchFlowNode = {
      id: n.id,
      type: n.kind,
      position: { x: l.x, y: l.y },
      data: { label: n.label ?? n.id, icon: n.icon },
      selected: selected.has(n.id),
    };
    if (n.parent && byId.has(n.parent)) node.parentId = n.parent;
    if (n.kind === 'group') {
      node.width = l.w ?? GROUP_DEFAULT.w;
      node.height = l.h ?? GROUP_DEFAULT.h;
      node.zIndex = -1;
    }
    return node;
  });
}

function toFlowEdges(d: Diagram, selectedIndex: number | null): Edge[] {
  return d.edges.map((e, i) => ({
    id: `e${i}`,
    source: e.from,
    target: e.to,
    sourceHandle: e.fromSide,
    targetHandle: e.toSide,
    label: e.label,
    type: 'smoothstep',
    selected: i === selectedIndex,
    markerEnd: e.arrowEnd ? { type: MarkerType.ArrowClosed, width: 18, height: 18 } : undefined,
    markerStart: e.arrowStart ? { type: MarkerType.ArrowClosed, width: 18, height: 18 } : undefined,
  }));
}

export function Canvas({ diagram, onChange, selection, onSelect, fitKey, onEditLabel }: Props) {
  const rf = useReactFlow<ArchFlowNode>();
  const selectedKey = selectedNodeIds(selection).join('\n');
  const selectedEdge = selection?.type === 'edge' ? selection.index : null;
  const [nodes, setNodes] = useState<ArchFlowNode[]>(() =>
    toFlowNodes(diagram, new Set(selectedNodeIds(selection))),
  );
  const edges = useMemo(() => toFlowEdges(diagram, selectedEdge), [diagram, selectedEdge]);
  const diagramRef = useRef(diagram);
  diagramRef.current = diagram;
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setNodes(toFlowNodes(diagram, new Set(selectedKey ? selectedKey.split('\n') : [])));
  }, [diagram, selectedKey]);

  useEffect(() => {
    // Let the canvas measure the new nodes first.
    const t = setTimeout(() => void rf.fitView({ padding: 0.15, duration: 200 }), 50);
    return () => clearTimeout(t);
  }, [fitKey, rf]);

  const onNodesChange = useCallback(
    (changes: NodeChange<ArchFlowNode>[]) => setNodes((ns) => applyNodeChanges(changes, ns)),
    [],
  );

  /** Absolute rectangle of a node as the canvas currently draws it. */
  const rectOf = useCallback(
    (id: string) => {
      const n = rf.getInternalNode(id);
      if (!n) return null;
      const { x, y } = n.internals.positionAbsolute;
      return { x, y, w: n.measured.width ?? n.width ?? 0, h: n.measured.height ?? n.height ?? 0 };
    },
    [rf],
  );

  /** Deepest group under a point, skipping `exclude` and everything inside it. */
  const groupAt = useCallback(
    (point: { x: number; y: number }, exclude?: string) => {
      const d = diagramRef.current;
      const skip = exclude ? descendantsOf(d, exclude) : new Set<string>();
      let best: { id: string; depth: number; area: number } | null = null;
      for (const g of d.nodes) {
        if (g.kind !== 'group' || skip.has(g.id)) continue;
        const r = rectOf(g.id);
        if (!r || point.x < r.x || point.y < r.y || point.x > r.x + r.w || point.y > r.y + r.h)
          continue;
        const cand = { id: g.id, depth: depthOf(d, g), area: r.w * r.h };
        if (
          !best ||
          cand.depth > best.depth ||
          (cand.depth === best.depth && cand.area < best.area)
        )
          best = cand;
      }
      return best?.id;
    },
    [rectOf],
  );

  const onNodeDragStop = useCallback(
    (_: unknown, __: unknown, dragged: ArchFlowNode[]) => {
      const d = diagramRef.current;
      const layout = { ...d.layout };
      const parents = new Map<string, string | undefined>();
      for (const n of dragged) {
        const r = rectOf(n.id);
        if (!r) continue;
        const parent = groupAt({ x: r.x + r.w / 2, y: r.y + r.h / 2 }, n.id);
        const pr = parent ? rectOf(parent) : null;
        const prev = layout[n.id];
        const next: NodeLayout = { x: r.x - (pr?.x ?? 0), y: r.y - (pr?.y ?? 0) };
        if (prev?.w !== undefined) Object.assign(next, { w: prev.w, h: prev.h });
        if (d.nodes.find((x) => x.id === n.id)?.kind === 'group') {
          next.w ??= r.w;
          next.h ??= r.h;
        }
        layout[n.id] = next;
        parents.set(n.id, parent);
      }
      const nodes = d.nodes.map((n) => {
        if (!parents.has(n.id)) return n;
        const { parent: _old, ...rest } = n;
        const parent = parents.get(n.id);
        return parent ? { ...rest, parent } : rest;
      });
      onChange({ ...d, nodes, layout });
    },
    [groupAt, onChange, rectOf],
  );

  const onConnect = useCallback(
    (c: Connection) => {
      if (!c.source || !c.target || c.source === c.target) return;
      const d = diagramRef.current;
      const a = rectOf(c.source);
      const b = rectOf(c.target);
      const guess =
        a && b
          ? sidesFor({ x: a.x + a.w / 2, y: a.y + a.h / 2 }, { x: b.x + b.w / 2, y: b.y + b.h / 2 })
          : { fromSide: 'R' as Side, toSide: 'L' as Side };
      onChange({
        ...d,
        edges: [
          ...d.edges,
          {
            from: c.source,
            to: c.target,
            fromSide: (c.sourceHandle as Side | null) ?? guess.fromSide,
            toSide: (c.targetHandle as Side | null) ?? guess.toSide,
            arrowEnd: true,
          },
        ],
      });
      onSelect({ type: 'edge', index: d.edges.length });
    },
    [onChange, onSelect, rectOf],
  );

  const onDelete = useCallback(
    ({ nodes: gone, edges: goneEdges }: { nodes: ArchFlowNode[]; edges: Edge[] }) => {
      let d = diagramRef.current;
      const drop = new Set(goneEdges.map((e) => Number(e.id.slice(1))));
      d = { ...d, edges: d.edges.filter((_, i) => !drop.has(i)) };
      for (const n of gone) d = removeNode(d, n.id);
      onChange(d);
      onSelect(null);
    },
    [onChange, onSelect],
  );

  const onSelectionChange = useCallback(
    ({ nodes: ns, edges: es }: OnSelectionChangeParams) => {
      if (ns.length > 1) onSelect({ type: 'nodes', ids: ns.map((n) => n.id) });
      else if (ns.length === 1 && !es.length) onSelect({ type: 'node', id: ns[0]!.id });
      else if (es.length === 1 && !ns.length)
        onSelect({ type: 'edge', index: Number(es[0]!.id.slice(1)) });
      else if (!ns.length && !es.length) onSelect(null);
    },
    [onSelect],
  );

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      const raw = event.dataTransfer.getData(DRAG_MIME);
      if (!raw) return;
      event.preventDefault();
      const item = JSON.parse(raw) as PaletteItem;
      const d = diagramRef.current;
      const point = rf.screenToFlowPosition({ x: event.clientX, y: event.clientY });
      const parent = groupAt(point);
      const pr = parent ? rectOf(parent) : null;
      const size =
        item.kind === 'group'
          ? GROUP_DEFAULT
          : item.kind === 'junction'
            ? JUNCTION_SIZE
            : SERVICE_SIZE;
      const id = makeId(
        item.kind === 'junction' ? 'junction' : item.label.toLowerCase(),
        d.nodes.map((n) => n.id),
      );
      const node: ArchNode = { id, kind: item.kind };
      if (item.kind !== 'junction') node.label = item.label;
      if (item.icon) node.icon = item.icon;
      if (parent) node.parent = parent;
      const layout: NodeLayout = {
        x: point.x - size.w / 2 - (pr?.x ?? 0),
        y: point.y - size.h / 2 - (pr?.y ?? 0),
      };
      if (item.kind === 'group') Object.assign(layout, { w: size.w, h: size.h });
      onChange({ ...d, nodes: [...d.nodes, node], layout: { ...d.layout, [id]: layout } });
      onSelect({ type: 'node', id });
    },
    [groupAt, onChange, onSelect, rectOf, rf],
  );

  const actions = useMemo(
    () => ({
      resizeGroup(id: string, box: { x: number; y: number; width: number; height: number }) {
        const d = diagramRef.current;
        onChange({
          ...d,
          layout: { ...d.layout, [id]: { x: box.x, y: box.y, w: box.width, h: box.height } },
        });
      },
    }),
    [onChange],
  );

  /**
   * Arrow-key nudges move the selection right away and are written to the diagram once the keys
   * go quiet, so a burst of presses is a single undo step.
   */
  const nudge = useRef<{
    start: Map<string, { x: number; y: number }>;
    dx: number;
    dy: number;
    timer: ReturnType<typeof setTimeout> | undefined;
  } | null>(null);

  const commitNudge = useCallback(() => {
    const n = nudge.current;
    if (!n) return;
    clearTimeout(n.timer);
    nudge.current = null;
    if (!n.dx && !n.dy) return;
    const d = diagramRef.current;
    const layout = { ...d.layout };
    for (const [id, p] of n.start) layout[id] = { ...layout[id], x: p.x + n.dx, y: p.y + n.dy };
    onChange({ ...d, layout });
  }, [onChange]);

  const commitNudgeRef = useRef(commitNudge);
  commitNudgeRef.current = commitNudge;
  useEffect(() => () => commitNudgeRef.current(), []);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('input, textarea, select, [contenteditable="true"]')) return;
      const dir = ARROWS[e.key];
      if (!dir || e.ctrlKey || e.metaKey || e.altKey) {
        commitNudge();
        return;
      }
      const all = nodesRef.current;
      const selected = new Set(all.filter((n) => n.selected).map((n) => n.id));
      const byId = new Map(all.map((n) => [n.id, n]));
      // A child already moves with its group; moving it too would double the step.
      const hasSelectedAncestor = (n: ArchFlowNode) => {
        for (let p = n.parentId, i = 0; p && i < 64; p = byId.get(p)?.parentId, i++)
          if (selected.has(p)) return true;
        return false;
      };
      const moving = all.filter((n) => n.selected && !hasSelectedAncestor(n));
      if (!moving.length) return;
      e.preventDefault();
      const ids = moving.map((n) => n.id).join('\n');
      if (nudge.current && [...nudge.current.start.keys()].join('\n') !== ids) commitNudge();
      const burst = (nudge.current ??= {
        start: new Map(moving.map((n) => [n.id, { ...n.position }])),
        dx: 0,
        dy: 0,
        timer: undefined,
      });
      const step = e.shiftKey ? 1 : 8;
      burst.dx += dir[0] * step;
      burst.dy += dir[1] * step;
      setNodes((ns) =>
        ns.map((n) => {
          const s = burst.start.get(n.id);
          return s ? { ...n, position: { x: s.x + burst.dx, y: s.y + burst.dy } } : n;
        }),
      );
      clearTimeout(burst.timer);
      burst.timer = setTimeout(commitNudge, NUDGE_COMMIT_MS);
    },
    [commitNudge],
  );

  return (
    <CanvasActionsContext.Provider value={actions}>
      <div
        ref={container}
        className="canvas"
        dir="ltr"
        // Focusable so arrow keys reach it after a click on the empty pane, not only on a node.
        tabIndex={-1}
        onMouseDownCapture={() => {
          const el = container.current;
          if (el && !el.contains(document.activeElement)) el.focus({ preventScroll: true });
        }}
        onKeyDown={onKeyDown}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) commitNudge();
        }}
        onDragOver={(e) => e.preventDefault()}
        onDrop={onDrop}
      >
        <ReactFlow<ArchFlowNode>
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onNodeDragStop={onNodeDragStop}
          onConnect={onConnect}
          onDelete={onDelete}
          onSelectionChange={onSelectionChange}
          onNodeDoubleClick={onEditLabel}
          connectionMode={ConnectionMode.Loose}
          deleteKeyCode={['Delete', 'Backspace']}
          multiSelectionKeyCode={['Shift', 'Meta', 'Control']}
          // Arrow keys are handled above, in grid steps and as one undoable change.
          disableKeyboardA11y
          onlyRenderVisibleElements={diagram.nodes.length > LARGE_DIAGRAM}
          colorMode="system"
          snapToGrid
          snapGrid={[8, 8]}
          fitView
          proOptions={{ hideAttribution: false }}
        >
          <Background gap={16} />
          <Controls />
          <MiniMap pannable zoomable />
        </ReactFlow>
      </div>
    </CanvasActionsContext.Provider>
  );
}

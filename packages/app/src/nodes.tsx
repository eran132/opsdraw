import { createContext, memo, useContext } from 'react';
import { Handle, NodeResizer, Position, type Node, type NodeProps } from '@xyflow/react';
import { Icon } from './Icon';

export interface NodeData extends Record<string, unknown> {
  label?: string;
  icon?: string;
}

export type ArchFlowNode = Node<NodeData>;

interface CanvasActions {
  resizeGroup(id: string, box: { x: number; y: number; width: number; height: number }): void;
}

export const CanvasActionsContext = createContext<CanvasActions>({ resizeGroup: () => {} });

const SIDES = [
  ['T', Position.Top],
  ['R', Position.Right],
  ['B', Position.Bottom],
  ['L', Position.Left],
] as const;

/** One handle per side; the canvas runs in loose mode so any handle can start or end an edge. */
function Handles() {
  return (
    <>
      {SIDES.map(([id, pos]) => (
        <Handle key={id} id={id} type="source" position={pos} className="handle" />
      ))}
    </>
  );
}

export const ServiceNode = memo(function ServiceNode({ data, selected }: NodeProps<ArchFlowNode>) {
  return (
    <div className={`arch-service${selected ? ' selected' : ''}`}>
      <Icon refName={data.icon} size={44} />
      <div className="arch-label" dir="auto">
        {data.label}
      </div>
      <Handles />
    </div>
  );
});

export const GroupNode = memo(function GroupNode({ id, data, selected }: NodeProps<ArchFlowNode>) {
  const actions = useContext(CanvasActionsContext);
  return (
    <div className={`arch-group${selected ? ' selected' : ''}`}>
      <NodeResizer
        isVisible={selected}
        minWidth={120}
        minHeight={80}
        onResizeEnd={(_, box) => actions.resizeGroup(id, box)}
      />
      <div className="arch-group-title" dir="auto">
        {data.icon && <Icon refName={data.icon} size={18} />}
        <span>{data.label}</span>
      </div>
      <Handles />
    </div>
  );
});

export const JunctionNode = memo(function JunctionNode({ selected }: NodeProps<ArchFlowNode>) {
  return (
    <div className={`arch-junction${selected ? ' selected' : ''}`}>
      <Handles />
    </div>
  );
});

export const nodeTypes = { service: ServiceNode, group: GroupNode, junction: JunctionNode };

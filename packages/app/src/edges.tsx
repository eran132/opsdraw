import { memo } from 'react';
import { BaseEdge, Position, type Edge, type EdgeProps } from '@xyflow/react';
import { polylinePath, routePoints, type Point, type Side } from '@opsdraw/core';

export interface RouteData extends Record<string, unknown> {
  /** Bend points from auto-layout, in absolute canvas coordinates (`%% @route`). */
  route: Point[];
}

export type RoutedFlowEdge = Edge<RouteData, 'routed'>;

const SIDE: Record<Position, Side> = {
  [Position.Top]: 'T',
  [Position.Bottom]: 'B',
  [Position.Left]: 'L',
  [Position.Right]: 'R',
};

/**
 * Draws an edge along its stored orthogonal route: out of the source handle, through the bend
 * points, into the target handle. Edges without a route use the built-in smoothstep edge.
 */
export const RoutedEdge = memo(function RoutedEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  label,
  markerEnd,
  markerStart,
  style,
}: EdgeProps<RoutedFlowEdge>) {
  const pts = routePoints(
    { x: sourceX, y: sourceY },
    SIDE[sourcePosition],
    data?.route ?? [],
    { x: targetX, y: targetY },
    SIDE[targetPosition],
  );
  const { d, labelAt } = polylinePath(pts);
  return (
    <BaseEdge
      id={id}
      path={d}
      label={label}
      labelX={labelAt.x}
      labelY={labelAt.y}
      markerEnd={markerEnd}
      markerStart={markerStart}
      style={style}
    />
  );
});

export const edgeTypes = { routed: RoutedEdge };

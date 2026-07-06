import type { Node } from 'reactflow';
import type { CanvasNodeLayout } from '../types';
import type { CanvasNodeData } from './types';

type RoleCarrier = Pick<CanvasNodeLayout, 'role'>;

export function isDurableSourceRole(role: RoleCarrier['role'] | undefined | null): boolean {
  return role?.type === 'style-ref-source';
}

export function isDurableSourceNode(node: Node<CanvasNodeData> | RoleCarrier | null | undefined): boolean {
  return Boolean(node && isDurableSourceRole('data' in node ? node.data.role : node.role));
}

export function canDeleteNode(node: Node<CanvasNodeData> | RoleCarrier | null | undefined): boolean {
  return !isDurableSourceNode(node);
}

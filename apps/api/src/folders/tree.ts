export interface TreeNode { id: string; parentId: string | null }

export function depthOf(nodes: readonly TreeNode[], id: string | null): number {
  const parents = new Map(nodes.map((node) => [node.id, node.parentId]));
  let depth = 0;
  for (let current = id; current; current = parents.get(current) ?? null) {
    if (++depth > nodes.length) break;
  }
  return depth;
}

export function heightOf(nodes: readonly TreeNode[], id: string): number {
  let level = [id];
  let height = 0;
  while (height <= nodes.length) {
    level = nodes.filter((node) => node.parentId !== null && level.includes(node.parentId)).map((node) => node.id);
    if (!level.length) break;
    height++;
  }
  return height;
}

export function isInside(nodes: readonly TreeNode[], id: string | null, ancestorId: string): boolean {
  const parents = new Map(nodes.map((node) => [node.id, node.parentId]));
  let steps = 0;
  for (let current = id; current; current = parents.get(current) ?? null) {
    if (current === ancestorId) return true;
    if (++steps > nodes.length) break;
  }
  return false;
}

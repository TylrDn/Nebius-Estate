import type { GraphEdge, GraphNode } from '@internal/nebius-domain';
import { RESOURCE_TYPE_LABELS } from '@internal/nebius-domain';
import { PLACEMENT_RELATIONS } from './catalog';

/**
 * Which part of the explorer graph is on screen. Pure, so it is unit-tested
 * apart from the SVG.
 *
 * - Collapsed by default: a node's children show only when it is open (or
 *   when it is on the path to the selected node, or a search is active).
 * - Siblings of one type fold into a single "N × type" node once there are
 *   TYPE_FOLD_MIN of them (an estate with 300 secrets shows one node).
 * - At most CHILD_CAP entries show under one parent; the rest fold into a
 *   "N more" node. Folded nodes open on activation.
 * - Edges are drawn only between nodes that are on screen.
 */
export const TYPE_FOLD_MIN = 5;
export const CHILD_CAP = 12;

export interface ViewNode {
  id: string;
  kind: GraphNode['kind'] | 'fold';
  label: string;
  sublabel?: GraphNode['sublabel'];
  hint?: GraphNode['hint'];
  type?: GraphNode['type'];
  status?: GraphNode['status'];
  depth: number;
  uid?: string;
  /** Fold nodes: the parent they hang from and the resources they stand for. */
  parent?: string;
  members?: string[];
}

export interface ViewEdge {
  from: string;
  to: string;
  relation: GraphEdge['relation'];
}

export interface GraphView {
  nodes: ViewNode[];
  edges: ViewEdge[];
  /** Real nodes whose children are being shown. */
  expanded: Set<string>;
  /** Direct children (in scope) per real node. */
  childCount: Map<string, number>;
}

export const foldTypeId = (parent: string, type: string) => `fold:${parent}:${type}`;
export const foldMoreId = (parent: string) => `fold:${parent}:*`;

/**
 * Everything "Expand all" opens: every node, and under every parent each type fold and the "N more" fold, so
 * no fold is left on screen.
 */
export function expandAllIds(nodes: GraphNode[], edges: GraphEdge[]): Set<string> {
  const byId = new Map(nodes.map(n => [n.id, n]));
  const open = new Set(nodes.map(n => n.id));
  for (const e of edges) {
    const child = byId.get(e.to);
    if (!child || !byId.has(e.from)) continue;
    open.add(foldTypeId(e.from, child.type ?? child.kind));
    open.add(foldMoreId(e.from));
  }
  return open;
}

interface Fold {
  id: string;
  parent: string;
  members: string[];
  type?: GraphNode['type'];
  depth: number;
}

export function computeGraphView({
  nodes,
  edges,
  open,
  selected,
  matches,
}: {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Opened node ids and opened fold ids. */
  open: ReadonlySet<string>;
  selected?: string;
  /** Search/filter matches; when set, only they and their ancestors are in scope, all opened. */
  matches?: ReadonlySet<string>;
}): GraphView {
  const byId = new Map(nodes.map(n => [n.id, n]));
  const children = new Map<string, string[]>();
  const parents = new Map<string, string[]>();
  for (const e of edges) {
    if (!byId.has(e.from) || !byId.has(e.to)) continue;
    const c = children.get(e.from) ?? [];
    if (!c.includes(e.to)) c.push(e.to);
    children.set(e.from, c);
    const p = parents.get(e.to) ?? [];
    if (!p.includes(e.from)) p.push(e.from);
    parents.set(e.to, p);
  }
  const ancestors = (id: string) => {
    const out = new Set<string>();
    const stack = [...(parents.get(id) ?? [])];
    while (stack.length) {
      const p = stack.pop()!;
      if (out.has(p)) continue;
      out.add(p);
      stack.push(...(parents.get(p) ?? []));
    }
    return out;
  };

  let scope: Set<string> | undefined;
  if (matches) {
    scope = new Set();
    for (const id of matches) {
      if (!byId.has(id)) continue;
      scope.add(id);
      ancestors(id).forEach(a => scope!.add(a));
    }
  }
  const inScope = (id: string) => !scope || scope.has(id);
  const forced = selected && byId.has(selected) ? new Set([selected, ...ancestors(selected)]) : new Set<string>();

  const visible = new Set<string>();
  const expanded = new Set<string>();
  const folds = new Map<string, Fold>();

  const fold = (parent: string, kids: GraphNode[]): string[] => {
    const show: string[] = [];
    const byType = new Map<string, GraphNode[]>();
    for (const n of kids) {
      if (forced.has(n.id)) {
        show.push(n.id);
        continue;
      }
      const key = n.type ?? n.kind;
      byType.set(key, [...(byType.get(key) ?? []), n]);
    }
    type Entry = { node: GraphNode } | { fold: Fold };
    const entries: Entry[] = [];
    for (const [key, list] of byType) {
      const id = foldTypeId(parent, key);
      if (list.length >= TYPE_FOLD_MIN && !open.has(id)) {
        entries.push({ fold: { id, parent, members: list.map(n => n.id), type: list[0].type, depth: list[0].depth } });
      } else entries.push(...list.map(node => ({ node })));
    }
    const moreId = foldMoreId(parent);
    let kept = entries;
    if (entries.length > CHILD_CAP && !open.has(moreId)) {
      kept = entries.slice(0, CHILD_CAP - 1);
      const rest = entries.slice(CHILD_CAP - 1);
      const members = rest.flatMap(e => ('node' in e ? [e.node.id] : e.fold.members));
      const depth = Math.min(...rest.map(e => ('node' in e ? e.node.depth : e.fold.depth)));
      folds.set(moreId, { id: moreId, parent, members, depth });
    }
    for (const e of kept) {
      if ('node' in e) show.push(e.node.id);
      else folds.set(e.fold.id, e.fold);
    }
    return show;
  };

  const order = (a: GraphNode, b: GraphNode) =>
    a.depth - b.depth || (a.type ?? '').localeCompare(b.type ?? '') || a.label.localeCompare(b.label) || a.id.localeCompare(b.id);

  const queue = nodes.filter(n => inScope(n.id) && !(parents.get(n.id) ?? []).some(inScope)).map(n => n.id);
  while (queue.length) {
    const id = queue.shift()!;
    if (visible.has(id)) continue;
    visible.add(id);
    if (!(matches || open.has(id) || forced.has(id))) continue;
    expanded.add(id);
    const kids = (children.get(id) ?? [])
      .filter(k => inScope(k) && !visible.has(k))
      .map(k => byId.get(k)!)
      .sort(order);
    queue.push(...fold(id, kids));
  }

  const viewNodes: ViewNode[] = nodes.filter(n => visible.has(n.id)).map(n => ({ ...n }));
  const viewEdges: ViewEdge[] = [];
  const seen = new Set<string>();
  for (const e of edges) {
    if (!visible.has(e.from) || !visible.has(e.to)) continue;
    const k = `${e.from}|${e.to}|${e.relation}`;
    if (seen.has(k)) continue;
    seen.add(k);
    viewEdges.push(e);
  }
  for (const f of folds.values()) {
    const members = f.members.filter(m => !visible.has(m));
    if (!members.length || !visible.has(f.parent)) continue;
    viewNodes.push({
      id: f.id,
      kind: 'fold',
      label: f.type ? `${members.length} × ${RESOURCE_TYPE_LABELS[f.type]}` : `${members.length} more`,
      type: f.type,
      depth: f.depth,
      parent: f.parent,
      members,
    });
    const rel = edges.find(e => e.from === f.parent && e.to === members[0])?.relation ?? 'contains';
    viewEdges.push({ from: f.parent, to: f.id, relation: rel });
  }

  const childCount = new Map<string, number>();
  for (const n of viewNodes) {
    if (n.kind === 'fold') continue;
    const c = (children.get(n.id) ?? []).filter(inScope).length;
    if (c) childCount.set(n.id, c);
  }
  return { nodes: viewNodes, edges: viewEdges, expanded, childCount };
}

/**
 * The graph's node count, explained against the "All resources" count: cloud resources, Kubernetes objects (namespaces,
 * workloads, pods; not inventory resources) and groups (tenant, project and region nodes; projects are resources in the
 * list, drawn here as groups), e.g. "76 nodes: 64 resources + 10 Kubernetes objects + 2 groups (project, region)".
 */
export function graphCountText(nodes: GraphNode[]): string {
  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const k8s = nodes.filter(n => n.kind === 'resource' && n.type?.startsWith('k8s-')).length;
  const resources = nodes.filter(n => n.kind === 'resource').length - k8s;
  const groups = nodes.filter(n => n.kind !== 'resource');
  const kinds = [...new Set(groups.map(g => g.kind))];
  const parts = [
    resources ? plural(resources, 'resource') : '',
    k8s ? plural(k8s, 'Kubernetes object') : '',
    groups.length ? `${plural(groups.length, 'group')} (${kinds.join(', ')})` : '',
  ].filter(Boolean);
  return `${plural(nodes.length, 'node')}: ${parts.join(' + ')}`;
}

const SEPARATORS = '-_./ ';

/**
 * A graph node's accessible name (WCAG 2.5.3 Label in Name): it starts with what the box shows, its label then its
 * type line, so speech input can name the node by what is on screen. When the box cut either, the full label and
 * type follow after a colon. `details` (status, children) end it.
 */
export function graphNodeName(shown: { label: string; type: string }, full: { label: string; type: string }, details: string[] = []): string {
  const visible = `${shown.label} ${shown.type}`;
  const head = shown.label === full.label && shown.type === full.type ? visible : `${visible}: ${full.label} ${full.type}`;
  return [head, ...details].join(', ');
}

/**
 * A label cut to `max` characters in the middle ("default-…eu-north1"), not at the end: siblings such as one default
 * project per region differ at the end, and an end cut made them read the same (W1F.N4). The kept end starts after a
 * separator when one is in it, so it is a whole token.
 */
export function middleClip(text: string, max: number): string {
  if (text.length <= max) return text;
  const budget = max - 1;
  let tail = text.slice(text.length - Math.ceil(budget / 2));
  const sep = [...tail].findIndex(c => SEPARATORS.includes(c));
  if (!SEPARATORS.includes(text[text.length - tail.length - 1]) && sep >= 0 && tail.length - sep - 1 >= 3) tail = tail.slice(sep + 1);
  return `${text.slice(0, budget - tail.length)}…${tail}`;
}

/**
 * A node label in at most `lines` lines of `room` characters: each line broken after a separator in its second half,
 * else at `room`; what does not fit the last line is cut in the middle. On a phone the graph gives ids three lines,
 * so "computefilesystem-e00mock…" reads in full instead of behind a tooltip (W1F.F1.37b).
 */
export function labelLines(text: string, room: number, lines = 1): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > room && out.length < lines - 1) {
    let cut = room;
    for (let i = room; i > room / 2; i--) {
      if (SEPARATORS.includes(rest[i - 1])) {
        cut = i;
        break;
      }
    }
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  out.push(middleClip(rest, room));
  return out;
}

/** Length of the prefix all texts share, ending at a separator so the differing part is whole tokens. */
function sharedPrefix(texts: string[]): number {
  const [first] = texts;
  const same = (i: number) => texts.every(t => t[i] === first[i]);
  let p = 0;
  while (p < first.length && same(p)) p++;
  while (p > 0 && !SEPARATORS.includes(first[p - 1])) p--;
  return p;
}

/** Length of the suffix all texts share (not overlapping the prefix), starting at a separator. */
function sharedSuffix(texts: string[], prefix: number): number {
  const [first] = texts;
  const shortest = Math.min(...texts.map(t => t.length)) - prefix;
  const same = (k: number) => texts.every(t => t[t.length - 1 - k] === first[first.length - 1 - k]);
  let n = 0;
  while (n < shortest && same(n)) n++;
  while (n > 0 && !SEPARATORS.includes(first[first.length - n])) n--;
  return n;
}

/** The cut "…differing…tail" of one label of a colliding group, given the group's shared prefix and suffix lengths. */
function distinctClip(text: string, prefix: number, suffix: number, room: number): string {
  const diff = text.slice(prefix, text.length - suffix);
  const head = prefix > 0 ? '…' : '';
  if (!suffix) return head + middleClip(diff, room - head.length);
  const left = room - head.length - diff.length - 1;
  if (left < 3) return `${head}${middleClip(diff, room - head.length - 1)}…`;
  let tail = text.slice(text.length - suffix);
  if (tail.length > left) tail = tail.slice(tail.length - left);
  while (tail.length > 1 && SEPARATORS.includes(tail[0])) tail = tail.slice(1);
  return `${head}${diff}…${tail}`;
}

/**
 * Node label lines (labelLines), except that labels which would read the same although they differ (two state buckets
 * "tfstate-nip-foundation-e00mock7c2a" and "tfstate-nip-sandbox-e00mock7c2a" both cut to "tfstate-nip…e00mock7c2a")
 * drop their shared prefix and suffix and keep the token that differs: "…foundation…e00mock7c2a" (G1.9).
 */
export function distinctLabelLines(items: { id: string; label: string; room: number }[], lines = 1): Map<string, string[]> {
  const out = new Map(items.map(i => [i.id, labelLines(i.label, i.room, lines)]));
  const groups = new Map<string, typeof items>();
  for (const i of items) {
    const key = out.get(i.id)!.join('\n');
    groups.set(key, [...(groups.get(key) ?? []), i]);
  }
  for (const group of groups.values()) {
    const texts = [...new Set(group.map(i => i.label))];
    if (texts.length < 2) continue;
    const p = sharedPrefix(texts);
    const sfx = sharedSuffix(texts, p);
    for (const i of group) out.set(i.id, [distinctClip(i.label, p, sfx, i.room)]);
  }
  return out;
}

/**
 * `open` with one node opened by hand (+ or →): its project and region children unfold with it, as on load, so one
 * click on the tenant after Collapse shows its projects instead of a "9 × Project" fold (G1.15). Resources of one type
 * still fold.
 */
export function openNode(prev: ReadonlySet<string>, id: string, nodes: GraphNode[], edges: GraphEdge[]): Set<string> {
  const next = new Set(prev);
  next.add(id);
  const byId = new Map(nodes.map(n => [n.id, n]));
  for (const e of edges) {
    const child = e.from === id ? byId.get(e.to) : undefined;
    if (child?.kind === 'project' || child?.kind === 'region') next.add(foldTypeId(id, child.type ?? child.kind));
  }
  return next;
}

/** The line above the graph: under a search, the matches apart from the parents drawn around them (G1.14). */
export function graphBarText(o: { shown: number; total: number; matches?: number; folds: number }): string {
  const folds = o.folds ? ` · ${o.folds} folded group${o.folds === 1 ? '' : 's'} (activate to open)` : '';
  if (o.matches !== undefined) {
    const parents = o.shown - o.matches;
    return `${o.matches} matching${parents > 0 ? ` · ${parents} parent${parents === 1 ? '' : 's'} shown` : ''}${folds}`;
  }
  return `${o.shown} of ${o.total} nodes shown${folds}${o.shown < o.total ? ' · use + on a node (or →) to expand' : ''}`;
}

/**
 * The view as an indented tree, for a box too narrow for the layered drawing (#21: at 390 px after "Expand all" the
 * columns left a 1760 px canvas of which the screen showed one node). Each node sits under its first placing parent
 * (a "contains" edge or a placement relation, or the node a fold hangs from), depth first in view order; a node with
 * no placing parent on screen is a root. Cross-references (routes, backed by, in subnet ...) never place a node.
 */
export function treeOrder(view: Pick<GraphView, 'nodes' | 'edges'>): { id: string; level: number; parent?: string }[] {
  const ids = new Set(view.nodes.map(n => n.id));
  const parent = new Map<string, string>();
  for (const n of view.nodes) if (n.kind === 'fold' && n.parent && ids.has(n.parent)) parent.set(n.id, n.parent);
  for (const e of view.edges) {
    if (parent.has(e.to) || !ids.has(e.from) || e.from === e.to) continue;
    if (e.relation === 'contains' || PLACEMENT_RELATIONS.has(e.relation)) parent.set(e.to, e.from);
  }
  const children = new Map<string, string[]>();
  for (const n of view.nodes) {
    const p = parent.get(n.id);
    if (p) children.set(p, [...(children.get(p) ?? []), n.id]);
  }
  const out: { id: string; level: number; parent?: string }[] = [];
  const seen = new Set<string>();
  const visit = (id: string, level: number) => {
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ id, level, ...(parent.get(id) ? { parent: parent.get(id) } : {}) });
    for (const c of children.get(id) ?? []) visit(c, level + 1);
  };
  for (const n of view.nodes) if (!parent.has(n.id)) visit(n.id, 0);
  // A placing cycle (not expected from the API) still shows every node once.
  for (const n of view.nodes) visit(n.id, 0);
  return out;
}

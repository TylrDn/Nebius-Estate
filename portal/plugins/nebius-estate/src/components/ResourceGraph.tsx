import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type { GraphEdge, GraphNode } from '@internal/nebius-domain';
import { lifecycleLabel, RESOURCE_TYPE_LABELS } from '@internal/nebius-domain';
import { PLACEMENT_RELATIONS, RELATION_LABELS } from '../pages/explorer/catalog';
import { computeGraphView, distinctLabelLines, expandAllIds, foldTypeId, graphBarText, graphNodeName, middleClip, openNode, treeOrder, type ViewNode } from '../pages/explorer/graphView';
import { GlyphPaths } from '../pages/explorer/TypeGlyph';

/**
 * Layered left-to-right graph that scales with the estate: it opens one level
 * expanded at tenant → project → region → top-level resources, and each node expands
 * to its direct children. Many siblings of one type fold into one node, and
 * long child lists end in a "N more" node (see pages/explorer/graphView.ts).
 * While a search/filter is active, only matches and their ancestors show.
 * Only edges present in the data are drawn; relations that do not place a
 * resource (routes, backed-by, in-subnet …) are drawn dotted.
 */
const COL_W = 216;
const NODE_W = 184;
/** A node with a one-line label; each further label line (a phone, W1F.F1.37b) adds LINE_H. */
const NODE_H1 = 36;
const ROW_GAP = 10;
const LINE_H = 13;
const PAD = 16;
const TEXT_X = 32;
/** A box narrower than this (a phone) gives long labels up to three lines instead of cutting them. */
const NARROW_BOX = 600;
const NARROW_LINES = 3;
const OPEN_BY_DEFAULT_BELOW_DEPTH = 3;
/** Indent per level of the tree drawing a narrow box uses (#21). */
const INDENT = 16;
/** The graph shrinks to fit its box down to this scale (text stays legible); a box narrower than that scrolls sideways. */
export const MIN_GRAPH_SCALE = 0.7;

/**
 * The scale that fits a graph of `width` into `available` px (F1.21): never enlarged, and applied only when it removes
 * the sideways scroll. A box too narrow even at MIN_GRAPH_SCALE (a phone) keeps full-size text and scrolls instead.
 */
export function fitScale(width: number, available: number): number {
  if (!available || width <= available) return 1;
  const fit = Math.floor((available / width) * 1000) / 1000;
  return fit >= MIN_GRAPH_SCALE ? fit : 1;
}

const STATUS_COLOR: Record<string, string> = {
  running: 'var(--ne-ok)',
  succeeded: 'var(--ne-ok)',
  pending: 'var(--ne-warn)',
  provisioning: 'var(--ne-info)',
  stopped: 'var(--ne-faint)',
  error: 'var(--ne-danger)',
  deleting: 'var(--ne-warn)',
  unknown: 'var(--ne-faint)',
};
const KIND_COLOR: Record<string, string> = { tenant: 'var(--ne-violet)', project: 'var(--ne-accent)', region: 'var(--ne-info)', fold: 'var(--ne-border-strong)', resource: 'var(--ne-border-strong)' };

function typeLabel(n: Pick<ViewNode, 'type' | 'kind'>) {
  if (n.kind === 'fold') return n.type ? 'Folded group' : 'Folded siblings';
  if (n.type) return RESOURCE_TYPE_LABELS[n.type];
  return n.kind === 'region' ? 'Region' : n.kind === 'project' ? 'Project' : 'Tenant';
}

/**
 * Opened on load: tenant, projects and regions, and their project and region children unfolded, so a tenant with many
 * projects opens one level expanded instead of "1 of 80 nodes" behind an "N × Project" fold (F1.44).
 */
function defaultOpen(nodes: GraphNode[], edges: GraphEdge[]): Set<string> {
  const byId = new Map(nodes.map(n => [n.id, n]));
  const open = new Set(nodes.filter(n => n.depth < OPEN_BY_DEFAULT_BELOW_DEPTH).map(n => n.id));
  for (const e of edges) {
    const child = byId.get(e.to);
    if (open.has(e.from) && (child?.kind === 'project' || child?.kind === 'region')) open.add(foldTypeId(e.from, child.type ?? child.kind));
  }
  return open;
}

export function ResourceGraph({
  nodes,
  edges,
  selected,
  onSelect,
  highlight,
  defaults,
}: {
  nodes: GraphNode[];
  edges: GraphEdge[];
  selected?: string;
  onSelect: (n: GraphNode) => void;
  highlight?: (n: GraphNode) => boolean;
  /** uids of Nebius-created project defaults (network, subnet, security group, route table). */
  defaults?: ReadonlySet<string>;
}) {
  const [open, setOpen] = useState<Set<string>>(() => defaultOpen(nodes, edges));
  const matches = useMemo(() => (highlight ? new Set(nodes.filter(highlight).map(n => n.id)) : undefined), [nodes, highlight]);
  const view = useMemo(() => computeGraphView({ nodes, edges, open, selected, matches }), [nodes, edges, open, selected, matches]);

  // Fit the box's width (F1.21): the SVG scales through its viewBox; measured on resize.
  const box = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState(0);
  useEffect(() => {
    const el = box.current;
    if (!el) return undefined;
    const measure = () => setAvailable(el.clientWidth);
    measure();
    const ro = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    ro?.observe(el);
    return () => ro?.disconnect();
  }, []);
  // Label lines per node: one (cut in the middle) on a wide box; on a phone up to three, so ids read in full.
  const narrow = available > 0 && available < NARROW_BOX;
  // Labels that would cut to the same text keep the part that differs (G1.9).
  const lines = useMemo(
    () =>
      distinctLabelLines(
        view.nodes.map(n => ({ id: n.id, label: n.label, room: n.kind === 'fold' ? 22 : (view.childCount.get(n.id) ?? 0) > 0 && !matches ? 18 : 23 })),
        narrow ? NARROW_LINES : 1,
      ),
    [view, narrow, matches],
  );
  const extraLines = Math.max(0, ...[...lines.values()].map(l => l.length - 1));
  const NODE_H = NODE_H1 + extraLines * LINE_H;
  const ROW_H = NODE_H + ROW_GAP;

  // A phone box the layered columns do not fit draws the same nodes as an indented tree (#21: after "Expand all" the
  // columns made a 1760 px canvas of which a 390 px screen showed one node over empty space).
  const columns = new Set(view.nodes.map(n => n.depth)).size;
  const tree = narrow && PAD * 2 + Math.max(columns, 1) * COL_W > available;
  const layout = useMemo(() => {
    if (tree) {
      const order = treeOrder(view);
      const pos = new Map<string, { x: number; y: number }>();
      order.forEach((r, i) => pos.set(r.id, { x: PAD + r.level * INDENT, y: PAD + i * ROW_H }));
      return {
        pos,
        height: PAD * 2 + Math.max(order.length, 1) * ROW_H,
        width: PAD * 2 + Math.max(0, ...order.map(r => r.level)) * INDENT + NODE_W,
        treeEdges: new Set(order.filter(r => r.parent).map(r => `${r.parent}>${r.id}`)),
      };
    }
    const parents = new Map<string, string[]>();
    for (const e of view.edges) parents.set(e.to, [...(parents.get(e.to) ?? []), e.from]);
    const cols = new Map<number, ViewNode[]>();
    for (const n of view.nodes) cols.set(n.depth, [...(cols.get(n.depth) ?? []), n]);
    const depths = [...cols.keys()].sort((a, b) => a - b);
    const colIndex = new Map(depths.map((d, i) => [d, i]));
    const row = new Map<string, number>();
    for (const d of depths) {
      const list = cols.get(d)!;
      const score = (n: ViewNode) => {
        const ps = (parents.get(n.id) ?? []).map(p => row.get(p)).filter((x): x is number => x !== undefined);
        return ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : Number.MAX_SAFE_INTEGER;
      };
      // Folds sit after the real siblings they summarise.
      list.sort((a, b) => score(a) - score(b) || Number(a.kind === 'fold') - Number(b.kind === 'fold') || a.label.localeCompare(b.label));
      list.forEach((n, i) => row.set(n.id, i));
    }
    const pos = new Map<string, { x: number; y: number }>();
    for (const n of view.nodes) pos.set(n.id, { x: PAD + colIndex.get(n.depth)! * COL_W, y: PAD + row.get(n.id)! * ROW_H });
    return {
      pos,
      height: PAD * 2 + Math.max(...depths.map(d => cols.get(d)!.length), 1) * ROW_H,
      width: PAD * 2 + Math.max(depths.length, 1) * COL_W,
      treeEdges: undefined as Set<string> | undefined,
    };
  }, [view, ROW_H, tree]);

  const neighbours = useMemo(() => {
    if (!selected) return undefined;
    const s = new Set([selected]);
    for (const e of view.edges) {
      if (e.from === selected) s.add(e.to);
      if (e.to === selected) s.add(e.from);
    }
    return s;
  }, [selected, view.edges]);

  const toggle = (id: string, want?: boolean) =>
    setOpen(prev => {
      const next = new Set(prev);
      const isOpen = view.expanded.has(id) || next.has(id);
      // Opening by hand unfolds the node's project and region children too (G1.15).
      if (want ?? !isOpen) return openNode(next, id, nodes, edges);
      next.delete(id);
      // Closing a node folds its children again next time it opens.
      for (const k of prev) if (k.startsWith(`fold:${id}:`)) next.delete(k);
      return next;
    });

  const scale = fitScale(layout.width, available);
  const clipped = available > 0 && layout.width * scale > available + 1;

  const realShown = view.nodes.filter(n => n.kind !== 'fold').length;
  const foldCount = view.nodes.length - realShown;
  return (
    <div>
      <div className="ne-between ne-xgraph-bar">
        <span className="ne-muted">
          {graphBarText({ shown: realShown, total: nodes.length, matches: matches ? view.nodes.filter(n => matches.has(n.id)).length : undefined, folds: foldCount })}
        </span>
        {!matches ? (
          <span className="ne-row" style={{ gap: 6 }}>
            <button type="button" className="ne-btn ne-btn-sm" onClick={() => setOpen(expandAllIds(nodes, edges))}>
              Expand all
            </button>
            {/* Folds to the roots (the tenant): the default view is already one level open, so going back to it did nothing (W1F.S4). */}
            <button type="button" className="ne-btn ne-btn-sm" onClick={() => setOpen(new Set())}>
              Collapse
            </button>
          </span>
        ) : null}
      </div>
      {tree ? (
        <p className="ne-faint ne-xgraph-note" role="note">
          Drawn as an indented tree to fit this screen: each resource sits under what contains it. Cross-references (routes, backed by, in subnet) show on a wider screen and in
          each resource&apos;s drawer.
        </p>
      ) : null}
      {clipped ? (
        <p className="ne-faint ne-xgraph-note" role="note">
          Wider than this screen: scroll the graph sideways, or switch to Table.
        </p>
      ) : null}
      {/* No taller than the drawing, nor than 70 % of the screen (a phone showed a 640 px box of mostly empty canvas). */}
      <div className="ne-graph" ref={box} style={{ maxHeight: 'min(640px, 70vh)' }} data-scale={scale} data-layout={tree ? 'tree' : 'columns'}>
        <svg
          width={Math.round(layout.width * scale)}
          height={Math.round(layout.height * scale)}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          role="group"
          aria-label="Resource relationship graph"
        >
          <g aria-hidden>
            {view.edges.map((e, i) => {
              const a = layout.pos.get(e.from)!;
              const b = layout.pos.get(e.to)!;
              if (layout.treeEdges) {
                // The tree draws each node's placing edge as an elbow from its parent; cross-references are left out.
                if (!layout.treeEdges.has(`${e.from}>${e.to}`)) return null;
                return <path key={i} d={`M${a.x + 8},${a.y + NODE_H} V${b.y + NODE_H / 2} H${b.x}`} className="ne-gedge" data-relation={e.relation} data-hot={selected !== undefined && (e.from === selected || e.to === selected)} />;
              }
              const x1 = a.x + NODE_W;
              const y1 = a.y + NODE_H / 2;
              const back = b.x <= x1;
              const d = back
                ? `M${a.x + NODE_W / 2},${a.y + NODE_H} C${a.x + NODE_W / 2},${a.y + NODE_H + 30} ${b.x + NODE_W / 2},${b.y - 30} ${b.x + NODE_W / 2},${b.y}`
                : `M${x1},${y1} C${x1 + 40},${y1} ${b.x - 40},${b.y + NODE_H / 2} ${b.x},${b.y + NODE_H / 2}`;
              const hot = selected !== undefined && (e.from === selected || e.to === selected);
              return (
                <path key={i} d={d} className="ne-gedge" data-relation={e.relation} data-cross={PLACEMENT_RELATIONS.has(e.relation) ? undefined : 'true'} data-hot={hot}>
                  <title>{RELATION_LABELS[e.relation].out}</title>
                </path>
              );
            })}
          </g>
          {view.nodes.map(n => {
            const p = layout.pos.get(n.id)!;
            if (n.kind === 'fold') {
              const openFold = () => setOpen(prev => new Set(prev).add(n.id));
              const foldType = `${typeLabel(n)} · show`;
              return (
                <g key={n.id} transform={`translate(${p.x},${p.y})`}>
                  <g
                    className="ne-gnode"
                    data-fold="true"
                    tabIndex={0}
                    role="button"
                    aria-expanded={false}
                    aria-label={graphNodeName({ label: lines.get(n.id)!.join(''), type: foldType }, { label: n.label, type: foldType }, ['folded. Activate to show them.'])}
                    data-dim={neighbours && !neighbours.has(n.parent ?? '') ? 'true' : undefined}
                    onClick={openFold}
                    onKeyDown={e => {
                      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowRight') {
                        e.preventDefault();
                        openFold();
                      }
                    }}
                  >
                    <rect width={NODE_W} height={NODE_H} rx={6} />
                    <g transform="translate(9,10) scale(0.667)">
                      <GlyphPaths type={n.type} />
                    </g>
                    <LabelText lines={lines.get(n.id)!} />{' '}
                    <text x={TEXT_X} y={28 + extraLines * LINE_H} className="ne-gnode-type">
                      {foldType}
                    </text>
                    <title>{n.label}</title>
                  </g>
                </g>
              );
            }
            const kids = view.childCount.get(n.id) ?? 0;
            const canToggle = !matches && kids > 0;
            const isOpen = canToggle && view.expanded.has(n.id);
            const dim = neighbours && !neighbours.has(n.id);
            const isDefault = Boolean(n.uid && defaults?.has(n.uid));
            const tLabel = typeLabel(n);
            const room = canToggle ? 18 : 23;
            // A region node is one project's resources there: its project is on the second line (F1.21).
            // A tenant whose name is unknown is labelled "Tenant" (#26): its second line is its id, not "Tenant" again.
            const bareTenant = n.kind === 'tenant' && n.label === tLabel && Boolean(n.hint);
            const sub = n.kind === 'region' && n.sublabel ? `${tLabel} · ${n.sublabel}` : bareTenant ? n.hint! : tLabel;
            // Tenant, project and region nodes open on a click; a node with a resource behind it is selected too (W1F.S4).
            const activate = () => {
              if (canToggle && !isOpen) toggle(n.id, true);
              if (n.uid) onSelect(n as GraphNode);
            };
            // No status on containers; "ready" for what holds data (lifecycleLabel).
            const status = n.kind === 'resource' ? lifecycleLabel(n.type, n.status) : undefined;
            const children = `${kids} ${kids === 1 ? 'child' : 'children'}`;
            // The type line as shown: the region's project is cut in the middle, so "Region · default-…eu-north1" keeps its end (W1F.N4).
            const shownSub = n.kind === 'region' && n.sublabel ? `${tLabel} · ${middleClip(n.sublabel, room - tLabel.length)}` : middleClip(sub, room - (isDefault ? 10 : 0) + 3);
            const typePrefix = isDefault ? 'default · ' : '';
            // Label in Name (WCAG 2.5.3): the name starts with the label and type line the box shows.
            const name = graphNodeName(
              { label: lines.get(n.id)!.join(''), type: `${typePrefix}${shownSub}` },
              { label: n.label, type: `${typePrefix}${sub}` },
              [isDefault ? 'project default' : '', status ?? '', canToggle ? (isOpen ? 'expanded' : `${children} hidden`) : ''].filter(Boolean),
            );
            return (
              <g key={n.id} transform={`translate(${p.x},${p.y})`}>
                <g
                  className="ne-gnode"
                  tabIndex={0}
                  role="button"
                  aria-label={name}
                  aria-pressed={selected === n.id}
                  data-selected={selected === n.id}
                  data-dim={dim ? 'true' : undefined}
                  onClick={activate}
                  onKeyDown={e => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      activate();
                    } else if (canToggle && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
                      e.preventDefault();
                      toggle(n.id, e.key === 'ArrowRight');
                    }
                  }}
                >
                  <rect width={NODE_W} height={NODE_H} rx={6} />
                  <rect width={3} height={NODE_H} rx={1.5} fill={status && n.status ? STATUS_COLOR[n.status] : KIND_COLOR[n.kind]} stroke="none" />
                  <g transform="translate(9,10) scale(0.667)">
                    <GlyphPaths type={n.type} />
                  </g>
                  {/* The spaces between the texts keep label and type apart in the text the node shows (Label in Name). */}
                  <LabelText lines={lines.get(n.id)!} />{' '}
                  <text x={TEXT_X} y={28 + extraLines * LINE_H} className="ne-gnode-type">
                    {isDefault ? <tspan className="ne-xdefault">default ·</tspan> : null}
                    {isDefault ? ' ' : null}
                    {shownSub}
                  </text>
                  <title>{`${n.label} (${sub}${n.hint && !bareTenant ? ` ${n.hint}` : ''}${isDefault ? ', project default' : ''}${status ? `, ${status}` : ''})`}</title>
                </g>
                {canToggle ? (
                  <g
                    className="ne-gtoggle"
                    transform={`translate(${NODE_W - 34},${(NODE_H - 18) / 2})`}
                    role="button"
                    tabIndex={0}
                    aria-label={isOpen ? `Collapse ${n.label}` : `+${kids > 99 ? '99' : kids} Expand ${n.label} (${children})`}
                    aria-expanded={isOpen}
                    onClick={() => toggle(n.id)}
                    onKeyDown={e => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        toggle(n.id);
                      }
                    }}
                  >
                    <rect width={28} height={18} rx={9} />
                    <text x={14} y={13} textAnchor="middle">
                      {isOpen ? '−' : `+${kids > 99 ? '99' : kids}`}
                    </text>
                  </g>
                ) : null}
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}

/** A node's label lines, one under the other (one on a wide box; up to three on a phone). */
function LabelText({ lines }: { lines: string[] }) {
  return (
    <text x={TEXT_X} y={15}>
      {lines.map((l, i) => (
        <Fragment key={i}>
          {/* A line broken at a space keeps that space in the text the node shows (Label in Name). */}
          {i > 0 && /\s$/.test(lines[i - 1]) ? ' ' : null}
          <tspan x={TEXT_X} dy={i ? LINE_H : 0}>
            {l}
          </tspan>
        </Fragment>
      ))}
    </text>
  );
}

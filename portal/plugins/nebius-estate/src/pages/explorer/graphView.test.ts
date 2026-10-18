import type { GraphEdge, GraphNode } from '@internal/nebius-domain';
import { CHILD_CAP, computeGraphView, treeOrder, distinctLabelLines, graphBarText, openNode, expandAllIds, foldMoreId, foldTypeId, graphCountText, labelLines, middleClip, TYPE_FOLD_MIN } from './graphView';

const region: GraphNode = { id: 'region:p:eu-north1', kind: 'region', label: 'eu-north1', depth: 2 };
const res = (id: string, type: GraphNode['type'], depth = 3): GraphNode => ({ id, kind: 'resource', label: id, type, depth, uid: id, status: 'running' });

function estate(secrets: number, extras = 0) {
  const nodes: GraphNode[] = [region, res('net', 'vpc-network'), res('rt', 'vpc-route-table', 4), res('sub', 'vpc-subnet', 4)];
  for (let i = 0; i < secrets; i++) nodes.push(res(`secret-${String(i).padStart(3, '0')}`, 'secret'));
  const types = ['ai-endpoint', 'ai-job', 'ai-devlab', 'kms-key', 'dns-zone', 'tunnel', 'container-registry', 'storage-transfer', 'vpc-pool', 'nvl-instance-group', 'storage-bucket', 'mlflow-cluster', 'postgresql-cluster', 'gpu-cluster'] as const;
  for (let i = 0; i < extras; i++) nodes.push(res(`extra-${i}`, types[i % types.length]));
  const edges: GraphEdge[] = nodes.filter(n => n.depth === 3).map(n => ({ from: region.id, to: n.id, relation: 'contains' }));
  edges.push({ from: 'net', to: 'rt', relation: 'in-network' }, { from: 'net', to: 'sub', relation: 'parent' }, { from: 'sub', to: 'rt', relation: 'routes' });
  return { nodes, edges };
}

describe('computeGraphView', () => {
  it('starts collapsed: only opened nodes show their children', () => {
    const { nodes, edges } = estate(2);
    const v = computeGraphView({ nodes, edges, open: new Set() });
    expect(v.nodes.map(n => n.id)).toEqual([region.id]);
    expect(v.childCount.get(region.id)).toBe(3);
  });

  it(`folds ${TYPE_FOLD_MIN}+ siblings of one type into one node, and opens the fold on request`, () => {
    const { nodes, edges } = estate(40);
    const v = computeGraphView({ nodes, edges, open: new Set([region.id]) });
    const fold = v.nodes.find(n => n.id === foldTypeId(region.id, 'secret'))!;
    expect(fold.kind).toBe('fold');
    expect(fold.members).toHaveLength(40);
    expect(fold.label).toBe('40 × Secret (metadata only)');
    expect(v.nodes.filter(n => n.type === 'secret' && n.kind !== 'fold')).toHaveLength(0);
    expect(v.edges).toContainEqual({ from: region.id, to: fold.id, relation: 'contains' });

    const opened = computeGraphView({ nodes, edges, open: new Set([region.id, fold.id, foldMoreId(region.id)]) });
    expect(opened.nodes.filter(n => n.type === 'secret')).toHaveLength(40);
  });

  it(`caps one parent at ${CHILD_CAP} entries and folds the rest into "N more"`, () => {
    const { nodes, edges } = estate(0, 30);
    const v = computeGraphView({ nodes, edges, open: new Set([region.id]) });
    const under = v.edges.filter(e => e.from === region.id);
    expect(under.length).toBeLessThanOrEqual(CHILD_CAP);
    const more = v.nodes.find(n => n.id === foldMoreId(region.id))!;
    const realUnder = v.nodes.filter(n => n.kind === 'resource' && n.depth === 3).length;
    const folded = v.nodes.filter(n => n.kind === 'fold').reduce((a, n) => a + n.members!.length, 0);
    expect(realUnder + folded).toBe(31); // 30 extras + the network
    expect(more.label).toMatch(/^\d+ more$/);
  });

  it('keeps the selected resource visible even inside a fold', () => {
    const { nodes, edges } = estate(40);
    const v = computeGraphView({ nodes, edges, open: new Set(), selected: 'secret-017' });
    expect(v.nodes.some(n => n.id === 'secret-017')).toBe(true);
    expect(v.nodes.find(n => n.kind === 'fold')?.members).toHaveLength(39);
  });

  it('draws cross-references only between nodes on screen, once each', () => {
    const { nodes, edges } = estate(0);
    const v = computeGraphView({ nodes, edges, open: new Set([region.id, 'net']) });
    expect(v.edges.filter(e => e.relation === 'routes')).toEqual([{ from: 'sub', to: 'rt', relation: 'routes' }]);
    const closed = computeGraphView({ nodes, edges, open: new Set([region.id]) });
    expect(closed.edges.some(e => e.relation === 'routes')).toBe(false);
  });

  it('shows only matches and their ancestors while searching', () => {
    const { nodes, edges } = estate(3);
    const v = computeGraphView({ nodes, edges, open: new Set(), matches: new Set(['rt']) });
    expect(v.nodes.map(n => n.id).sort()).toEqual(['net', 'region:p:eu-north1', 'rt', 'sub']);
  });

  it('"Expand all" opens every node and every fold: type folds and "N more"', () => {
    const { nodes, edges } = estate(40, 30);
    const v = computeGraphView({ nodes, edges, open: expandAllIds(nodes, edges) });
    expect(v.nodes.filter(n => n.kind === 'fold')).toEqual([]);
    expect(v.nodes).toHaveLength(nodes.length);
  });
});

describe('graph node count (walkthrough 3)', () => {
  it('explains the node count against "All resources": resources, Kubernetes objects and groups', () => {
    const nodes: GraphNode[] = [
      { id: 'tenant', kind: 'tenant', label: 't', depth: 0 },
      { id: 'project:p', kind: 'project', label: 'p', depth: 1 },
      region,
      res('vm', 'compute-instance'),
      res('disk', 'compute-disk'),
      res('k8s:c:ns:default', 'k8s-namespace', 4),
      res('k8s:c:pod:default/x', 'k8s-pod', 5),
    ];
    expect(graphCountText(nodes)).toBe('7 nodes: 2 resources + 2 Kubernetes objects + 3 groups (tenant, project, region)');
    expect(graphCountText([res('vm', 'compute-instance')])).toBe('1 node: 1 resource');
  });
});

describe('node labels (W1F.N4, W1F.F1.37b)', () => {
  it('cut a long label in the middle, keeping the end that tells siblings apart', () => {
    expect(middleClip('default-project-eu-north1', 18)).toBe('default-…eu-north1');
    expect(middleClip('default-project-eu-west1', 18)).toBe('default-p…eu-west1');
    expect(middleClip('nip-lab', 18)).toBe('nip-lab');
    expect(middleClip('default-project-eu-north1', 18)).toHaveLength(18);
  });

  it('wrap a long id over up to three lines, broken after a separator where one is near the end of a line', () => {
    const lines = labelLines('computefilesystem-e00mocksopcontrollerspool', 23, 3);
    expect(lines.join('')).toBe('computefilesystem-e00mocksopcontrollerspool');
    expect(lines[0]).toBe('computefilesystem-');
    expect(lines.every(l => l.length <= 23)).toBe(true);
    // One line only: the middle goes.
    expect(labelLines('computefilesystem-e00mocksopcontrollerspool', 23)).toEqual([middleClip('computefilesystem-e00mocksopcontrollerspool', 23)]);
    // Too long even for three lines: the last line is cut in the middle, nothing else.
    const long = labelLines('a'.repeat(100), 23, 3);
    expect(long).toHaveLength(3);
    expect(long[2]).toContain('…');
    expect(labelLines('nip-lab', 23, 3)).toEqual(['nip-lab']);
  });
});

describe('labels that clip to the same text keep the part that differs (G1.9)', () => {
  it('two state buckets that differ only in the middle read apart', () => {
    const items = [
      { id: 'a', label: 'tfstate-nip-foundation-e00mock7c2a', room: 23 },
      { id: 'b', label: 'tfstate-nip-sandbox-e00mock7c2a', room: 23 },
      { id: 'c', label: 'nip-lab', room: 23 },
    ];
    const out = distinctLabelLines(items, 1);
    expect(out.get('a')).toEqual(['…foundation…e00mock7c2a']);
    expect(out.get('b')).toEqual(['…sandbox…e00mock7c2a']);
    expect(out.get('c')).toEqual(['nip-lab']);
    for (const v of out.values()) expect(v[0].length).toBeLessThanOrEqual(23);
    expect(new Set([...out.values()].map(v => v.join('|'))).size).toBe(3);
  });

  it('leaves labels that already differ as labelLines cuts them', () => {
    const items = [
      { id: 'a', label: 'default-project-eu-north1', room: 18 },
      { id: 'b', label: 'default-project-eu-west1', room: 18 },
    ];
    const out = distinctLabelLines(items, 1);
    expect(out.get('a')).toEqual(labelLines('default-project-eu-north1', 18));
    expect(out.get('b')).toEqual(labelLines('default-project-eu-west1', 18));
  });
});

describe('expanding a node after Collapse (G1.15)', () => {
  const tenant: GraphNode = { id: 'tenant:t', kind: 'tenant', label: 't', depth: 0 };
  const projects: GraphNode[] = Array.from({ length: 9 }, (_, i) => ({ id: `project:p${i}`, kind: 'project', label: `p${i}`, depth: 1 }));
  const nodes = [tenant, ...projects];
  const edges: GraphEdge[] = projects.map(p => ({ from: tenant.id, to: p.id, relation: 'contains' }));

  it('one + on the tenant shows its projects, not a folded "9 × Project" node', () => {
    const open = openNode(new Set(), tenant.id, nodes, edges);
    const v = computeGraphView({ nodes, edges, open });
    expect(v.nodes.filter(n => n.kind === 'fold')).toEqual([]);
    expect(v.nodes.filter(n => n.kind === 'project')).toHaveLength(9);
  });

  it('still folds many resources of one type under an expanded node', () => {
    const { nodes: n2, edges: e2 } = estate(40);
    const v = computeGraphView({ nodes: n2, edges: e2, open: openNode(new Set(), region.id, n2, e2) });
    expect(v.nodes.find(n => n.id === foldTypeId(region.id, 'secret'))?.kind).toBe('fold');
  });
});

describe('the graph header under a search (G1.14)', () => {
  it('counts the matches apart from the parents drawn around them', () => {
    expect(graphBarText({ shown: 5, total: 80, matches: 2, folds: 0 })).toBe('2 matching · 3 parents shown');
    expect(graphBarText({ shown: 1, total: 80, matches: 1, folds: 0 })).toBe('1 matching');
    expect(graphBarText({ shown: 10, total: 80, folds: 1 })).toBe('10 of 80 nodes shown · 1 folded group (activate to open) · use + on a node (or →) to expand');
  });
});


describe('treeOrder (#21: on a phone the expanded graph is an indented tree, not a tall empty canvas)', () => {
  it('lists each node under its placing parent, depth first, with its level; cross-references do not place', () => {
    const { nodes, edges } = estate(0);
    const v = computeGraphView({ nodes, edges, open: new Set([region.id, 'net']) });
    const order = treeOrder(v);
    expect(order.map(r => `${'  '.repeat(r.level)}${r.id}`)).toEqual([region.id, '  net', '    rt', '    sub']);
    // The route table is placed under its network (in-network), not under the subnet it routes.
    expect(order.find(r => r.id === 'rt')!.parent).toBe('net');
    expect(order.find(r => r.id === region.id)!.parent).toBeUndefined();
  });

  it('a fold sits under the node it hangs from', () => {
    const { nodes, edges } = estate(40);
    const v = computeGraphView({ nodes, edges, open: new Set([region.id]) });
    const fold = treeOrder(v).find(r => r.id === foldTypeId(region.id, 'secret'))!;
    expect(fold).toMatchObject({ level: 1, parent: region.id });
  });
});

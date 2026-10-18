import { fireEvent, render, screen } from '@testing-library/react';
import type { GraphEdge, GraphNode } from '@internal/nebius-domain';
import { fitScale, MIN_GRAPH_SCALE, ResourceGraph } from '../../components/ResourceGraph';

const region: GraphNode = { id: 'region:p:eu-north1', kind: 'region', label: 'eu-north1', sublabel: 'sandbox', depth: 2 };
const project: GraphNode = { id: 'project:p', kind: 'project', label: 'sandbox', depth: 1 };
const net: GraphNode = { id: 'nebius:vpcnetwork-1', kind: 'resource', label: 'default-network', type: 'vpc-network', depth: 3, uid: 'nebius:vpcnetwork-1', status: 'running' };
const secrets: GraphNode[] = Array.from({ length: 8 }, (_, i) => ({ id: `nebius:mbsec-${i}`, kind: 'resource', label: `secret-${i}`, type: 'secret', depth: 3, uid: `nebius:mbsec-${i}`, status: 'running' }));
const nodes = [project, region, net, ...secrets];
const edges: GraphEdge[] = [
  { from: project.id, to: region.id, relation: 'contains' },
  ...[net, ...secrets].map(n => ({ from: region.id, to: n.id, relation: 'contains' as const })),
];

describe('ResourceGraph', () => {
  it('folds many siblings of one type, opens the fold, and marks project defaults', () => {
    render(<ResourceGraph nodes={nodes} edges={edges} onSelect={() => undefined} defaults={new Set([net.uid!])} />);
    expect(screen.getByRole('button', { name: /^default-network default · VPC network, project default/ })).toBeInTheDocument();
    const fold = screen.getByRole('button', { name: /^8 × Secr.*folded/ });
    expect(screen.queryByRole('button', { name: /secret-3/ })).toBeNull();
    fireEvent.click(fold);
    expect(screen.getByRole('button', { name: /^secret-3 Secret \(metadata only\)/ })).toBeInTheDocument();
  });

  it('"Expand all" opens folded groups too, and keeps them open', () => {
    render(<ResourceGraph nodes={nodes} edges={edges} onSelect={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: /8 × Secret/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));
    expect(screen.queryByRole('button', { name: /folded/ })).toBeNull();
    expect(screen.getByText(`${nodes.length} of ${nodes.length} nodes shown`)).toBeInTheDocument();
  });

  it('a tenant shown as "Tenant" carries its id on the second line, not "Tenant" twice (#26)', () => {
    const tenant: GraphNode = { id: 'tenant:tenant-e00x', kind: 'tenant', label: 'Tenant', hint: 'tenant-e00x', depth: 0 };
    render(<ResourceGraph nodes={[tenant, { ...project, depth: 1 }]} edges={[{ from: tenant.id, to: project.id, relation: 'contains' }]} onSelect={() => undefined} />);
    const node = screen.getByRole('button', { name: /^Tenant tenant-e00x/ });
    const texts = [...node.querySelectorAll('text')].map(t => t.textContent);
    expect(texts).toEqual(['Tenant', 'tenant-e00x']);
    expect(node.querySelector('title')!.textContent).toBe('Tenant (tenant-e00x)');
  });

  it('names the project of a region node, and says "ready" (not "running") for a network (F1.21)', () => {
    render(<ResourceGraph nodes={nodes} edges={edges} onSelect={() => undefined} />);
    expect(screen.getByRole('button', { name: /^eu-north1 Region · sandbox/ })).toBeInTheDocument();
    expect(screen.getByText('Region · sandbox')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^default-network VPC network, ready/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /running/ })).toBeNull();
  });

  it('opens one level expanded: a tenant with many projects shows each project, never "1 of N nodes" (F1.44)', () => {
    const tenant: GraphNode = { id: 'tenant:t', kind: 'tenant', label: 'tenant', depth: 0 };
    const projects: GraphNode[] = Array.from({ length: 9 }, (_, i) => ({ id: `project:p${i}`, kind: 'project', label: `project-${i}`, depth: 1 }));
    const regions: GraphNode[] = projects.map((p, i) => ({ id: `region:p${i}:eu-north1`, kind: 'region', label: 'eu-north1', sublabel: p.label, depth: 2 }));
    render(<ResourceGraph nodes={[tenant, ...projects, ...regions]} edges={[...projects.map(p => ({ from: tenant.id, to: p.id, relation: 'contains' as const })), ...projects.map((p, i) => ({ from: p.id, to: regions[i].id, relation: 'contains' as const }))]} onSelect={() => undefined} />);
    expect(screen.queryByRole('button', { name: /× Project/ })).toBeNull();
    for (const p of projects) expect(screen.getByRole('button', { name: new RegExp(`^${p.label} Project`) })).toBeInTheDocument();
    expect(screen.getByText('19 of 19 nodes shown')).toBeInTheDocument();
  });

  it('"Collapse" folds the graph to the tenant, also from the default view (W1F.S4)', () => {
    const tenant: GraphNode = { id: 'tenant:t', kind: 'tenant', label: 'tenant-e00mocktest', depth: 0 };
    const all = [tenant, ...nodes];
    const withTenant = [{ from: tenant.id, to: project.id, relation: 'contains' as const }, ...edges];
    render(<ResourceGraph nodes={all} edges={withTenant} onSelect={() => undefined} />);
    expect(screen.getByRole('button', { name: /^sandbox Project/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Collapse' }));
    expect(screen.queryByRole('button', { name: /^sandbox Project/ })).toBeNull();
    expect(screen.getByText(`1 of ${all.length} nodes shown`, { exact: false })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^\+1 Expand tenant-e00mocktest \(1 child\)/ })).toBeInTheDocument();
  });

  it('a click on a tenant, project or region node opens it; a project with a uid is selected too (W1F.S4)', () => {
    const onSelect = jest.fn();
    const tenant: GraphNode = { id: 'tenant:t', kind: 'tenant', label: 'tenant-e00mocktest', depth: 0 };
    const proj: GraphNode = { ...project, uid: 'nebius:project-p' };
    render(<ResourceGraph nodes={[tenant, proj, region, net]} edges={[{ from: tenant.id, to: proj.id, relation: 'contains' }, ...edges.slice(0, 2)]} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole('button', { name: 'Collapse' }));
    fireEvent.click(screen.getByRole('button', { name: /^tenant-e00mocktest Tenant/ }));
    expect(screen.getByRole('button', { name: /^sandbox Project/ })).toBeInTheDocument();
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /^sandbox Project/ }));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ uid: 'nebius:project-p' }));
    expect(screen.getByRole('button', { name: /^eu-north1 Region/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^eu-north1 Region/ }));
    expect(screen.getByRole('button', { name: /^default-network VPC network/ })).toBeInTheDocument();
  });

  it('cuts long names in the middle, so one default project per region still reads apart (W1F.N4)', () => {
    const p1: GraphNode = { id: 'project:a', kind: 'project', label: 'default-project-eu-north1', depth: 1 };
    const p2: GraphNode = { id: 'project:b', kind: 'project', label: 'default-project-eu-west1', depth: 1 };
    const r1: GraphNode = { id: 'region:a:eu-north1', kind: 'region', label: 'eu-north1', sublabel: p1.label, depth: 2 };
    const r2: GraphNode = { id: 'region:b:eu-west1', kind: 'region', label: 'eu-west1', sublabel: p2.label, depth: 2 };
    render(<ResourceGraph nodes={[p1, p2, r1, r2]} edges={[{ from: p1.id, to: r1.id, relation: 'contains' }, { from: p2.id, to: r2.id, relation: 'contains' }]} onSelect={() => undefined} />);
    const texts = [...document.querySelectorAll('svg text')].map(t => t.textContent ?? '');
    expect(texts.some(t => /^default-.*….*eu-north1$/.test(t))).toBe(true);
    expect(texts.some(t => /^default-.*….*eu-west1$/.test(t))).toBe(true);
    expect(texts.filter(t => t.startsWith('Region · ')).every(t => /(north|west)1$/.test(t))).toBe(true);
  });

  it('names each node and toggle starting with the text it shows, so speech input can address it (WCAG 2.5.3, Label in Name)', () => {
    const long: GraphNode = { id: 'nebius:mk8s-1', kind: 'resource', label: 'nip-sandbox-inference', type: 'mk8s-cluster', depth: 3, uid: 'nebius:mk8s-1', status: 'running' };
    const pool: GraphNode = { id: 'nebius:ng-1', kind: 'resource', label: 'gpu-pool', type: 'mk8s-node-group', depth: 4, uid: 'nebius:ng-1', status: 'running' };
    const tenant: GraphNode = { id: 'tenant:t', kind: 'tenant', label: 'Tenant', hint: 'tenant-e00mocktest', depth: 0 };
    render(
      <ResourceGraph
        nodes={[tenant, ...nodes, long, pool]}
        edges={[{ from: tenant.id, to: project.id, relation: 'contains' }, ...edges, { from: region.id, to: long.id, relation: 'contains' }, { from: long.id, to: pool.id, relation: 'contains' }]}
        onSelect={() => undefined}
        defaults={new Set([net.uid!])}
      />,
    );
    // axe's label-content-name-mismatch: the element's text, joined as axe joins it (each element's text trimmed), with
    // punctuation removed, must be part of its accessible name.
    const shown = (el: Node): string =>
      [...el.childNodes].map(c => (c.nodeType === 3 ? c.nodeValue ?? '' : c.nodeName === 'title' ? '' : shown(c))).join('').replace(/\s+/g, ' ').trim();
    const curate = (t: string) => t.toLowerCase().replace(/[\u2000-\u206F\u2E00-\u2E7F\\'!"#$%&()*+,\-./:;<=>?@[\]^_`{|}~]/g, '').replace(/\s+/g, ' ').trim();
    const buttons = [...document.querySelectorAll('svg [role="button"]')];
    expect(buttons.length).toBeGreaterThan(5);
    // A toggle that shows only "−" has no word to say (axe leaves symbol-only text out); it is named "Collapse …".
    for (const b of buttons.filter(el => /[\p{L}\p{N}]/u.test(shown(el)))) expect(curate(b.getAttribute('aria-label') ?? '')).toContain(curate(shown(b)));
    expect(screen.getByRole('button', { name: /^nip-sand…inference Managed Kuber…cluster: nip-sandbox-inference Managed Kubernetes cluster, running/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^\+1 Expand nip-sandbox-inference \(1 child\)/ })).toBeInTheDocument();
  });

  it('shrinks a wide graph to fit its box, never below the legible minimum and never enlarged (F1.21)', () => {
    expect(fitScale(1000, 1200)).toBe(1);
    expect(fitScale(1328, 1118)).toBeCloseTo(0.841, 3);
    // Exactly the legible minimum still fits: shrunk.
    expect(fitScale(1000, 1000 * MIN_GRAPH_SCALE)).toBe(MIN_GRAPH_SCALE);
    // A phone: even the minimum would not remove the sideways scroll, so the text is not shrunk for nothing.
    expect(fitScale(1328, 358)).toBe(1);
    expect(fitScale(1328, 0)).toBe(1); // not measured yet (or no layout): drawn at full size
  });
});

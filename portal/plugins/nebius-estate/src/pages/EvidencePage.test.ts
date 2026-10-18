import { docButtonLabel, docLink, findAnchor, findHeading, rawAnchors, repoLiveText, splitLatestSession, splitTitleDate, stripRawAnchors } from './EvidencePage';

describe('docLink', () => {
  it('opens relative repository links in the document viewer', () => {
    expect(docLink('runbooks/deploy.md', '../docs/cost.md')).toBe(`?doc=${encodeURIComponent('docs/cost.md')}`);
    expect(docLink('terraform/stacks/network/README.md', './variables.tf#L3')).toBe(`?doc=${encodeURIComponent('terraform/stacks/network/variables.tf')}#L3`);
    expect(docLink('docs/evidence/README.md', '/README.md')).toBe(`?doc=${encodeURIComponent('README.md')}`);
  });

  it('keeps the open document for an in-document anchor, and the anchor for links to other documents', () => {
    expect(docLink('README.md', '#pick-a-recipe')).toBe(`?doc=${encodeURIComponent('README.md')}#pick-a-recipe`);
    expect(docLink('docs/evidence/2026-10-11-portal-live-read-only.md', '#method')).toBe(`?doc=${encodeURIComponent('docs/evidence/2026-10-11-portal-live-read-only.md')}#method`);
    expect(docLink('runbooks/deploy.md', '../docs/cost.md#required-labels')).toBe(`?doc=${encodeURIComponent('docs/cost.md')}#required-labels`);
  });

  it('G5.9: keeps the page\'s other URL parameters (tab, price) when it opens another document', () => {
    const search = '?tab=recipes&doc=terraform%2Fstacks%2Finference%2FREADME.md';
    expect(docLink('terraform/stacks/inference/README.md', '../../../platform/README.md#stage-policy', search)).toBe(`?tab=recipes&doc=${encodeURIComponent('platform/README.md')}#stage-policy`);
    expect(docLink('terraform/stacks/inference/README.md', '#inputs', search)).toBe(`?tab=recipes&doc=${encodeURIComponent('terraform/stacks/inference/README.md')}#inputs`);
    expect(docLink('solutions/S2-x/README.md', '../../docs/cost.md', '?price=S2&doc=solutions%2FS2-x%2FREADME.md')).toBe(`?price=S2&doc=${encodeURIComponent('docs/cost.md')}`);
    expect(docLink('README.md', 'https://docs.nebius.com/', search)).toBe('https://docs.nebius.com/');
  });

  it('keeps http(s) links, and neutralises other schemes', () => {
    expect(docLink('README.md', 'https://docs.nebius.com/')).toBe('https://docs.nebius.com/');
    expect(docLink('README.md', ['javascript', 'alert(1)'].join(':'))).toBe('#');
    expect(docLink('README.md', 'data:text/html,x')).toBe('#');
  });
});

describe('in-document anchors', () => {
  it('finds a heading by its id, or by the GitHub slug of its text', () => {
    const root = document.createElement('div');
    root.innerHTML = '<h2 id="method">Method</h2><h2 id="r1---inference-serving">R1 — Inference serving</h2>';
    expect(findHeading(root, 'method')?.textContent).toBe('Method');
    expect(findHeading(root, 'r1--inference-serving')?.textContent).toBe('R1 — Inference serving');
    expect(findHeading(root, 'nope')).toBeUndefined();
  });
});

describe('raw HTML anchors (<a id>), which the sanitizer strips', () => {
  const md = 'See [step 2b](#tenant-reads).\n\n1. Step\n\n   <a id="tenant-reads"></a>**2b. Tenant reads (optional, each one enables a portal page).** Project\n   permits cannot see it.\n\n<a name="old"></a>\n## Old heading\n';
  it('remembers the text that follows each anchor', () => {
    expect(rawAnchors(md)).toEqual(
      new Map([
        ['tenant-reads', '2b. Tenant reads (optional, each one enables a portal page). Project'],
        ['old', 'Old heading'],
      ]),
    );
  });
  it('takes them out before rendering, so no empty link is rendered', () => {
    expect(stripRawAnchors(md)).not.toMatch(/<a /);
    expect(stripRawAnchors(md)).toContain('   **2b. Tenant reads');
  });

  it('finds the element the anchor stood before, and gives it the id', () => {
    const root = document.createElement('div');
    root.innerHTML = '<p>See <a href="#tenant-reads">step 2b</a>.</p><ol><li><p>Step</p><p><strong>2b. Tenant reads (optional, each one enables a portal page).</strong> Project permits cannot see it.</p></li></ol><h2>Old heading</h2>';
    const el = findAnchor(root, 'tenant-reads', rawAnchors(md));
    expect(el?.tagName).toBe('P');
    expect(el?.textContent).toMatch(/^2b\. Tenant reads/);
    expect(el?.id).toBe('tenant-reads');
    expect(findAnchor(root, 'old', rawAnchors(md))?.tagName).toBe('H2');
    expect(findAnchor(root, 'missing', rawAnchors(md))).toBeUndefined();
  });
});

describe('live runs of this repository', () => {
  it('says which live roots were applied, from the evidence items', () => {
    expect(repoLiveText([])).toBe('No evidence file records an apply of a Terraform root of this repository yet.');
    expect(repoLiveText([{ date: '2026-10-11', liveRoot: 'terraform/live/sandbox/inference' }])).toBe(
      'Terraform roots applied so far, per the evidence files: sandbox/inference (2026-10-11).',
    );
  });
});

describe('splitLatestSession (live runs stay one session long on a phone)', () => {
  const run = (id: string, date?: string) => ({ id, date });
  it('keeps the newest session open and folds every earlier one, newest first, in the order given', () => {
    const { latest, earlier } = splitLatestSession([run('a', '2026-10-11'), run('b', '2026-10-12'), run('c', '2026-10-10'), run('d', '2026-10-12'), run('e', '2026-10-11')]);
    expect(latest).toEqual({ date: '2026-10-12', items: [run('b', '2026-10-12'), run('d', '2026-10-12')] });
    expect(earlier.map(s => [s.date, s.items.map(i => i.id)])).toEqual([
      ['2026-10-11', ['a', 'e']],
      ['2026-10-10', ['c']],
    ]);
  });

  it('folds undated runs after the dated sessions, and keeps them all open when nothing is dated', () => {
    const { latest, earlier } = splitLatestSession([run('x'), run('a', '2026-10-11')]);
    expect(latest.items.map(i => i.id)).toEqual(['a']);
    expect(earlier).toEqual([{ date: undefined, items: [run('x')] }]);
    expect(splitLatestSession([run('x'), run('y')])).toEqual({ latest: { date: undefined, items: [run('x'), run('y')] }, earlier: [] });
    expect(splitLatestSession([])).toEqual({ latest: { date: undefined, items: [] }, earlier: [] });
  });
});

describe('document buttons (WCAG 2.5.3, label in name)', () => {
  it('name the button starting with its visible text, then the path it opens', () => {
    expect(docButtonLabel('Portal live read-only run', 'docs/evidence/2026-10-11-portal-live-read-only.md')).toBe('Portal live read-only run, read docs/evidence/2026-10-11-portal-live-read-only.md');
    expect(docButtonLabel('deploy.md', 'runbooks/deploy.md')).toBe('deploy.md, read runbooks/deploy.md');
  });
});

describe('#10: an evidence title keeps its date in one piece', () => {
  it('splits the trailing "— <date>" off the title, so it can be kept on one line', () => {
    expect(splitTitleDate('Token Factory smoke test (R11) — 2026-10-11')).toEqual({ head: 'Token Factory smoke test (R11)', date: '— 2026-10-11' });
    expect(splitTitleDate('Soperator 4.1.13, CPU worker: `sbatch` end to end — 2026-10-07/08')).toEqual({ head: 'Soperator 4.1.13, CPU worker: `sbatch` end to end', date: '— 2026-10-07/08' });
    expect(splitTitleDate('Spend of the prior validation runs (2026-10-07/08)')).toEqual({ head: 'Spend of the prior validation runs (2026-10-07/08)' });
    expect(splitTitleDate('R5 Workflow platform: no run of this repository yet')).toEqual({ head: 'R5 Workflow platform: no run of this repository yet' });
  });
});

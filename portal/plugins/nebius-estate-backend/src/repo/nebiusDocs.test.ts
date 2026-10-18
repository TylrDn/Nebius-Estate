import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { cleanMirror, NebiusDocs } from './nebiusDocs';
import { RepoReader } from './RepoReader';

/** A repository with a two-page catalog and a mirror holding one of them. */
function repoWith(mirror: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'nebius-docs-'));
  mkdirSync(join(root, 'docs/reference'), { recursive: true });
  writeFileSync(
    join(root, 'docs/reference/nebius-docs.json'),
    JSON.stringify({
      generated: '2026-10-11',
      source: 'the test catalog',
      sections: { overview: { pages: 2, reference_only: false } },
      key_pages: [{ path: '/overview/quotas', why: 'Quotas' }],
      pages: {
        '/overview/quotas': { path: '/overview/quotas', title: 'Quotas in Nebius AI Cloud', headings: [{ level: 2, text: 'Change quotas', anchor: 'change-quotas' }, { level: 3, text: 'x', anchor: 'x' }] },
        '/overview/regions': { path: '/overview/regions', title: 'Nebius AI Cloud regions' },
      },
    }),
  );
  if (mirror) {
    mkdirSync(join(root, '.cache/nebius-docs/overview'), { recursive: true });
    writeFileSync(join(root, '.cache/nebius-docs/index.md'), '# Home\n');
    writeFileSync(join(root, '.cache/nebius-docs/overview/quotas.md'), '> ## Documentation Index\n> Fetch the index.\n\n# Quotas\n\n<Icon icon="x" />Text.\n\n<CardGroup cols={2}>\n  <Card title="A" href="/a">\n    Body\n  </Card>\n</CardGroup>\n\n## Change quotas\n');
  }
  return new NebiusDocs(new RepoReader(root));
}

describe('the Nebius docs catalog and its mirror (#11)', () => {
  it('lists sections, pages and key pages, and says whether the mirror is present', async () => {
    const docs = repoWith(true);
    const idx = await docs.index();
    expect(idx).toMatchObject({ generated: '2026-10-11', mirror: true, sections: [{ name: 'overview', pages: 2, referenceOnly: false }], keyPages: [{ path: '/overview/quotas', why: 'Quotas' }] });
    expect(idx.pages).toEqual([
      { path: '/overview/quotas', title: 'Quotas in Nebius AI Cloud', section: 'overview' },
      { path: '/overview/regions', title: 'Nebius AI Cloud regions', section: 'overview' },
    ]);
    expect((await repoWith(false).index()).mirror).toBe(false);
  });

  it('opens a catalogued page from the mirror without its preamble or MDX components; never a path the catalog does not list', async () => {
    const docs = repoWith(true);
    const page = await docs.page('/overview/quotas');
    expect(page).toMatchObject({ title: 'Quotas in Nebius AI Cloud', url: 'https://docs.nebius.com/overview/quotas', mirrored: true, headings: [{ text: 'Change quotas', anchor: 'change-quotas' }] });
    expect(page!.markdown).toBe('# Quotas\n\nText.\n\nBody\n\n## Change quotas');
    expect(await docs.page('/overview/regions')).toMatchObject({ mirrored: false });
    expect(await docs.page('/../../etc/passwd')).toBeUndefined();
    expect(await docs.page('/overview/unknown')).toBeUndefined();
  });

  it('cleanMirror keeps prose and code, drops components', () => {
    expect(cleanMirror('<Note>\nKeep this.\n</Note>\n\n```bash\nnebius x <y>\n```')).toBe('Keep this.\n\n```bash\nnebius x <y>\n```');
  });
});

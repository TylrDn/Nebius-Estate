import { DOCS_ORIGIN, docsSection, NebiusDocsPageResponse, NebiusDocsResponse } from '@internal/nebius-domain';
import { RepoReader } from './RepoReader';

/**
 * The Nebius docs catalog (docs/reference/nebius-docs.json) and its local page mirror (.cache/nebius-docs/<path>.md,
 * written by `make docs-catalog`, git-ignored) for the Nebius docs page (#11). Only pages the catalog lists can be
 * opened, so a request names a catalogued path, never a file.
 */
const CATALOG = 'docs/reference/nebius-docs.json';

interface Catalog {
  generated: string;
  source: string;
  sections: Record<string, { pages: number; reference_only: boolean }>;
  key_pages: { path: string; why: string }[];
  pages: Record<string, { path: string; title: string; headings?: { level: number; text: string; anchor: string }[] }>;
}

const mirrorPath = (path: string) => `.cache/nebius-docs/${path.replace(/^\/+|\/+$/g, '') || 'index'}.md`;

/**
 * Mirrored Markdown without the page's preamble and its MDX components (cards, icons, tabs), which do not render here.
 * Text inside a component is indented two spaces per level in the source; that indent goes with the component, so the
 * text does not turn into a code block. Fenced code is left as it is.
 */
export function cleanMirror(markdown: string): string {
  const out: string[] = [];
  let depth = 0;
  let fence = false;
  for (const raw of markdown.replace(/^(?:>.*\n)+\n?/, '').split('\n')) {
    const line = fence ? raw : raw.slice(Math.min(raw.length - raw.trimStart().length, 2 * depth));
    if (/^\s*```/.test(line)) fence = !fence;
    if (fence || /^\s*```/.test(line)) {
      out.push(line);
      continue;
    }
    const t = line.trim();
    // A component on a line of its own opens or closes a level; inline ones are dropped where they stand.
    if (/^<\/[A-Z][A-Za-z]*>$/.test(t)) {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (/^<[A-Z][A-Za-z]*\b[^>]*[^/]>$/.test(t) || /^<[A-Z][A-Za-z]*>$/.test(t)) {
      depth++;
      continue;
    }
    out.push(line.replace(/<([A-Z][A-Za-z]*)\b[^>]*\/>/g, '').replace(/<\/?[A-Z][A-Za-z]*\b[^>]*>/g, ''));
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export class NebiusDocs {
  private cache?: { at: number; catalog: Catalog };

  constructor(private readonly repo: RepoReader, private readonly ttlMs = 60_000) {}

  private async catalog(): Promise<Catalog> {
    if (this.cache && Date.now() - this.cache.at < this.ttlMs) return this.cache.catalog;
    const catalog = JSON.parse(await this.repo.read(CATALOG)) as Catalog;
    this.cache = { at: Date.now(), catalog };
    return catalog;
  }

  async index(): Promise<NebiusDocsResponse> {
    const c = await this.catalog();
    return {
      generated: c.generated,
      source: c.source,
      sections: Object.entries(c.sections).map(([name, s]) => ({ name, pages: s.pages, referenceOnly: s.reference_only })),
      pages: Object.values(c.pages).map(p => ({ path: p.path, title: p.title, section: docsSection(p.path) })),
      keyPages: c.key_pages.map(k => ({ path: k.path, why: k.why })),
      mirror: await this.repo.exists(mirrorPath('/')),
    };
  }

  /** One catalogued page, with its mirrored Markdown when the mirror has it; undefined when the catalog does not list it. */
  async page(path: string): Promise<NebiusDocsPageResponse | undefined> {
    const c = await this.catalog();
    const p = c.pages[path];
    if (!p) return undefined;
    const base = { path: p.path, title: p.title, url: `${DOCS_ORIGIN}${p.path === '/' ? '/' : p.path}`, headings: (p.headings ?? []).filter(h => h.level === 2).map(h => ({ text: h.text, anchor: h.anchor })) };
    const markdown = await this.repo.read(mirrorPath(p.path)).catch(() => undefined);
    return markdown === undefined ? { ...base, mirrored: false } : { ...base, mirrored: true, markdown: cleanMirror(markdown) };
  }
}

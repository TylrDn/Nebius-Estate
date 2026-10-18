import { useSearchParams } from 'react-router-dom';
import type { EvidenceResponse, SolutionsResponse } from '@internal/nebius-domain';
import { Async, PageShell, useGet } from '../ui';
import { DocViewer } from './EvidencePage';
import { SolutionsTab } from './solutions/SolutionsTab';

/**
 * Solutions S1–S9 on their own page (F1.23; they were a second tab under Evidence): scenario, composed recipes,
 * status, Read, and the priced-footprint view. The priced solution (`?price=`) and the open document (`?doc=`)
 * live in the URL.
 */
export function SolutionsPage() {
  const solutions = useGet<SolutionsResponse>('/solutions');
  // Recipe titles for the recipe buttons' tooltips; the page works without them.
  const evidence = useGet<EvidenceResponse>('/evidence');
  const [params, setParams] = useSearchParams();
  const set = (key: 'price' | 'doc', value: string | undefined, replace = false) =>
    setParams(
      prev => {
        const p = new URLSearchParams(prev);
        if (value) p.set(key, value);
        else p.delete(key);
        return p;
      },
      { replace },
    );
  const price = params.get('price') ?? undefined;
  const doc = params.get('doc') ?? undefined;
  return (
    <PageShell
      title="Solutions"
      subtitle="Customer scenarios that compose several recipes, each with sizing, a priced cost model and an account of what is proven. Price a footprint through the Nebius billing calculator here."
      filters={false}
    >
      <Async load={solutions} rows={6}>
        {sol => (
          <SolutionsTab
            data={sol}
            openDoc={p => set('doc', p)}
            price={price}
            setPrice={id => set('price', id)}
            recipeTitles={Object.fromEntries((evidence.data?.recipes ?? []).map(r => [r.id, r.title]))}
          />
        )}
      </Async>
      {/* Closing replaces the open document, so Back goes to before it opened (as on Evidence). */}
      <DocViewer path={doc} onClose={() => set('doc', undefined, true)} />
    </PageShell>
  );
}

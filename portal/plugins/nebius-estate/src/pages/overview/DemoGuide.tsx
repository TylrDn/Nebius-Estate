import type { GlobalFilter, Meta } from '@internal/nebius-domain';
import { Link } from 'react-router-dom';
import { filterQuery, Reference } from '../../ui';

/** Optional orientation for synthetic data; operational figures remain first on small screens. */
export function DemoGuide({ testData, filter = {} }: { testData: Meta['testData']; filter?: GlobalFilter }) {
  if (!testData) return null;
  const search = filterQuery(filter);
  return (
    <Reference id="demo-tour" title="Explore this demo" hint="A short tour of the existing pages, using synthetic data.">
      <p className="ne-muted">
        You are exploring an invented estate. A provisioning preview does not apply infrastructure;
        the evidence pages describe separate, dated runs.
      </p>
      <ol>
        <li><p><Link to={`/estate${search}`}>Estate Explorer</Link>: open a resource and inspect its project, region and relationships.</p></li>
        <li><p><Link to={`/costs${search}`}>Costs</Link>: compare the selected billing metric, currency and imported period.</p></li>
        <li><p><Link to={`/provisioning${search}`}>Provisioning</Link>: inspect policy checks, intended file changes and a run sheet.</p></li>
        <li><p><Link to={`/evidence${search}`}>Evidence &amp; Runbooks</Link>: distinguish historical measurements from mocked checks.</p></li>
        <li><p><Link to={`/nebius-docs${search}`}>Nebius docs</Link>: search the catalog and follow the official source links.</p></li>
      </ol>
    </Reference>
  );
}

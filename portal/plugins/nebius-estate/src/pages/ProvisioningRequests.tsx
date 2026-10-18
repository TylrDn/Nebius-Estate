import { useState } from 'react';
import type { ListResponse, ProvisioningRequestRecord } from '@internal/nebius-domain';
import { Async, Callout, Card, DataTable, EmptyState, fmtTime, Icon, Loadable, StatusPill, useBackend, useDownload, useMeta } from '../ui';

/** Steps 5–7 of the provisioning flow: the prepared request, its patch, and the request list. */

const patchPath = (id: string) => `/provisioning/requests/${id}/patch`;
const patchName = (id: string) => `nebius-estate-${id.slice(0, 8)}.patch`;

export function CreatedRequest({ rec }: { rec: ProvisioningRequestRecord }) {
  const { download, error } = useDownload();
  return (
    <div className="ne-stack">
      <Callout tone="info" title={`Request ${rec.id.slice(0, 8)} prepared`}>
        Next: download the patch, apply it on a branch, run <code>make ci</code>, open a PR. After merge, follow the run sheet with a written spend approval.
      </Callout>
      <div className="ne-row">
        <button type="button" className="ne-btn" onClick={() => download(patchPath(rec.id), patchName(rec.id), 'text/x-diff')}>
          <Icon name="download" size={15} /> Download patch
        </button>
      </div>
      {error ? <Callout tone="danger">{error}</Callout> : null}
    </div>
  );
}

/** Step 6: there is no CI integration, so the step says where the check happens instead of staying blank. */
export function CiPlanStatus() {
  return (
    <Card title="6 · CI / plan status" icon="info">
      <div className="ne-muted" style={{ fontSize: '0.8125rem', maxWidth: 760, overflowWrap: 'anywhere' }}>
        No CI integration is configured, so this step is not tracked here. After you apply the patch on a branch, run <code>make ci</code> locally and
        read the saved plan (<code>make plan</code>) yourself, then open the pull request. The deploy pipeline (.github/workflows/terraform.yml) ships
        disabled and is never dispatched from the portal.
      </div>
    </Card>
  );
}

/** The evidence file a deployed request points at (the backend checks the same pattern). */
export const EVIDENCE_PATH = /^docs\/evidence\/[A-Za-z0-9.-]+\.md$/;

/**
 * A request's actions by state (G5.1): prepared → Mark approved or Withdraw; approved → Mark deployed (with its
 * docs/evidence/ file) or Withdraw. Deployed and withdrawn are final. The patch downloads in every state.
 */
export function RequestActions({
  r,
  canRequest,
  act,
  onPatch,
}: {
  r: ProvisioningRequestRecord;
  canRequest: boolean;
  act: (id: string, path: string, body?: object) => Promise<boolean>;
  onPatch: () => void;
}) {
  const [asking, setAsking] = useState(false);
  const [evidence, setEvidence] = useState('');
  const [invalid, setInvalid] = useState(false);
  const fieldId = `pv-evidence-${r.id.slice(0, 8)}`;
  const deploy = async () => {
    const path = evidence.trim();
    if (!EVIDENCE_PATH.test(path)) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    if (await act(r.id, 'evidence', { state: 'deployed', evidence: path })) setAsking(false);
  };
  return (
    <div className="ne-stack" style={{ gap: 6 }}>
      <div className="ne-row" style={{ gap: 4 }}>
        <button type="button" className="ne-btn ne-btn-sm" onClick={onPatch}>
          Patch
        </button>
        {canRequest && r.state === 'prepared' ? (
          <button type="button" className="ne-btn ne-btn-sm" onClick={() => act(r.id, 'evidence', { state: 'approved' })}>
            Mark approved
          </button>
        ) : null}
        {canRequest && r.state === 'approved' ? (
          <button type="button" className="ne-btn ne-btn-sm" aria-expanded={asking} onClick={() => setAsking(a => !a)}>
            Mark deployed
          </button>
        ) : null}
        {canRequest && (r.state === 'prepared' || r.state === 'approved') ? (
          <button type="button" className="ne-btn ne-btn-sm ne-btn-ghost" onClick={() => act(r.id, 'withdraw')}>
            Withdraw
          </button>
        ) : null}
        {r.evidence ? <code style={{ overflowWrap: 'anywhere' }}>{r.evidence}</code> : null}
      </div>
      {asking && r.state === 'approved' ? (
        <form
          className="ne-row"
          style={{ gap: 4, flexWrap: 'wrap' }}
          onSubmit={e => {
            e.preventDefault();
            deploy();
          }}
        >
          <label htmlFor={fieldId} className="ne-sr-only">
            Evidence file for {r.input.requestRef}
          </label>
          <input
            id={fieldId}
            className="ne-input ne-mono"
            style={{ minWidth: 0, flex: '1 1 220px', fontSize: '0.75rem' }}
            placeholder="docs/evidence/2026-10-12-sandbox-inference-run.md"
            value={evidence}
            aria-invalid={invalid ? 'true' : undefined}
            aria-describedby={`${fieldId}-hint`}
            onChange={e => setEvidence(e.target.value)}
          />
          <button type="submit" className="ne-btn ne-btn-sm ne-btn-primary">
            Save deployed
          </button>
          <div id={`${fieldId}-hint`} className={invalid ? 'ne-field-error' : 'ne-faint'} style={{ flexBasis: '100%', fontSize: 'var(--ne-fs-caption)' }}>
            {invalid ? 'Enter a file as docs/evidence/<name>.md (letters, digits, dots and dashes).' : 'The evidence file of the run, as docs/evidence/<name>.md; commit it with the run.'}
          </div>
        </form>
      ) : null}
    </div>
  );
}

export function RequestList({ load }: { load: Loadable<ListResponse<ProvisioningRequestRecord>> }) {
  const call = useBackend();
  const meta = useMeta();
  const { download, error: downloadError } = useDownload();
  const [actionError, setActionError] = useState<string>();
  const canRequest = meta.data?.permissions['nebius.provisioning.request.create'];
  const act = async (id: string, path: string, body?: object) => {
    setActionError(undefined);
    let ok = true;
    try {
      await call(`/provisioning/requests/${id}/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    } catch (e) {
      ok = false;
      setActionError((e as Error).message);
    }
    load.reload();
    return ok;
  };
  const error = actionError ?? downloadError;
  return (
    <Card title={`7 · Approval and deployment evidence${load.data ? ` — ${load.data.items.length} request${load.data.items.length === 1 ? '' : 's'}` : ''}`} icon="evidence" flush footer="States: prepared → approved → deployed (with a docs/evidence/ file), or withdrawn. A request that changes a sizing file holds it until it is deployed or withdrawn (one open change per file; one that changes nothing holds none); a request is refused when its file changed since the preview.">
      {error ? <div style={{ padding: 12 }}><Callout tone="danger">{error}</Callout></div> : null}
      <Async load={load} rows={3}>
        {d => (
          <DataTable<ProvisioningRequestRecord>
            caption="Provisioning requests"
            rows={d.items}
            rowKey={r => r.id}
            empty={<EmptyState title="No provisioning requests yet">Requests you prepare above appear here.</EmptyState>}
            columns={[
              { key: 'id', header: 'Request', render: r => <div><div style={{ fontWeight: 600 }}>{r.input.requestRef}</div><div className="ne-mono ne-faint">{r.id.slice(0, 8)}</div></div> },
              { key: 'recipe', header: 'Recipe · stage', render: r => `${r.input.recipe} · ${r.input.stage}` },
              { key: 'gpus', header: 'GPU nodes', align: 'right', render: r => r.input.gpuNodeCount },
              { key: 'state', header: 'State', render: r => <StatusPill state={r.state === 'prepared' ? 'pending' : r.state === 'deployed' ? 'ok' : r.state === 'withdrawn' ? 'disabled' : 'provisioning'} label={r.state} /> },
              { key: 'by', header: 'Created', render: r => <span className="ne-muted">{fmtTime(r.createdAt)} · {r.createdBy}</span> },
              {
                key: 'act',
                header: '',
                render: r => <RequestActions r={r} canRequest={Boolean(canRequest)} act={act} onPatch={() => download(patchPath(r.id), patchName(r.id), 'text/x-diff')} />,
              },
            ]}
          />
        )}
      </Async>
    </Card>
  );
}

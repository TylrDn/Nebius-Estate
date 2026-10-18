import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  FilterOptions,
  ListResponse,
  LivePriceResponse,
  PreviewResponse,
  ProvisioningRequestInput,
  ProvisioningRequestRecord,
  RecipeDefinition,
  RecipesResponse,
  ScenarioEstimate,
} from '@internal/nebius-domain';
import { DRAFT_QUOTE_LABEL, estimateHeadline, LIVE_LIST_BOOK_ID } from '@internal/nebius-domain';
import {
  ApiError,
  Async,
  Badge,
  Callout,
  Card,
  DataTable,
  DiffView,
  EmptyState,
  Field,
  fieldMessageId,
  fmtMoney,
  Icon,
  KeyValue,
  PageShell,
  useBackend,
  useGet,
  useMeta,
  usePortalNow,
} from '../ui';
import { CiPlanStatus, CreatedRequest, RequestList } from './ProvisioningRequests';
import { AvailabilityCard, QuotaNeedsCard, ReservationsCard } from './provisioning/LiveChecks';
import { Committed, committedFor, fieldOrigin, prefill, setByProfile, shrinkOf, SizingField, switchFor } from './provisioning/form';
import { LivePricePanel, RATE_BOOK_LABEL } from './pricing/LivePricePanel';
import { failureState, LivePriceState, pendingState } from './pricing/livePrice';
import { clientFieldErrors, FIELD_LABELS, readableInputError } from './provisioning/validate';
import { stepStates } from './provisioning/steps';

const STEPS = ['Configure', 'Validate', 'Preview changes', 'Estimate', 'Prepare reviewed change', 'CI / plan status', 'Approval & evidence'];

/**
 * A fresh request for a recipe: every sizing field from the committed sizing file of its first stage (W1-P1), so an
 * untouched field writes nothing.
 */
function defaultsFor(recipe: RecipeDefinition, data: RecipesResponse, now: Date): ProvisioningRequestInput {
  const stage = recipe.stages[0];
  const ttl = new Date(now.getTime() + 8 * 3_600_000);
  ttl.setUTCMinutes(0, 0, 0);
  const base: ProvisioningRequestInput = {
    recipe: recipe.id,
    stage,
    region: 'eu-north1',
    platform: null,
    gpuNodeCount: 0,
    capacityType: recipe.capacityTypes[0],
    ttlExpires: data.stages[stage]?.require_ttl_label ? ttl.toISOString().replace('.000Z', 'Z') : undefined,
    runtimeHours: 8,
    owner: 'platform',
    requestRef: '',
  };
  return prefill(base, committedFor(data, recipe, stage), recipe.capacityTypes);
}

/** Where a sizing field's value comes from (W1-P1, #27), beside its label. */
function Origin({ field, input, committed }: { field: SizingField; input: ProvisioningRequestInput; committed: Committed }) {
  if (!committed.sizingFile) return null;
  const o = fieldOrigin(field, input, committed);
  return (
    <>
      {' '}
      <Badge tone={o.tone}>{o.label}</Badge>
    </>
  );
}

export function ProvisioningPage() {
  const recipes = useGet<RecipesResponse>('/provisioning/recipes');
  const requests = useGet<ListResponse<ProvisioningRequestRecord>>('/provisioning/requests');
  // The wizard needs the caller's permissions (meta) before it can offer "Prepare".
  const meta = useMeta();
  return (
    <PageShell
      title="Provisioning"
      subtitle="Prepare a reviewed configuration change from a recipe. Nothing is applied from the browser: you get a patch and a run sheet; CI, the stage policy and the saved-plan review decide."
      filters={false}
    >
      <Callout tone="info" title="What this page can and cannot do">
        It validates against platform/stages.yaml and platform/regions.yaml, previews the exact tfvars diff and estimates the footprint. It never runs
        terraform, never dispatches the (disabled) deploy pipeline and never writes to the repository. Frontend checks are advisory; CI and the
        plan-time preconditions stay authoritative.
      </Callout>
      <div className="ne-section">
        <Async load={{ ...recipes, data: meta.data ? recipes.data : undefined, loading: recipes.loading || meta.loading }} rows={8}>
          {data => <Wizard data={data} onCreated={requests.reload} />}
        </Async>
      </div>
      <div className="ne-section">
        <RequestList load={requests} />
      </div>
      {recipes.data?.catalog ? (
        <div className="ne-section">
          <OtherRecipes catalog={recipes.data.catalog} sizing={recipes.data.sizing} />
        </div>
      ) : null}
    </PageShell>
  );
}

/**
 * Recipes without a form: Terraform stacks with live roots are listed read-only with their sizing files
 * (the form model edits sizing keys these roots do not carry); the rest are documentation and runbooks.
 */
function OtherRecipes({ catalog, sizing }: { catalog: RecipesResponse['catalog']; sizing: RecipesResponse['sizing'] }) {
  const rows = catalog.filter(r => r.provisioning !== 'form');
  return (
    <Card
      title="Recipes without a form"
      icon="provision"
      flush
      footer="Read-only here: nothing is generated for them. Their READMEs, runbooks and evidence rows are on Evidence & Runbooks → Recipes; the GPU caps come from platform/stages.yaml."
    >
      <DataTable
        caption="Recipes without a provisioning form"
        rows={rows}
        rowKey={r => r.id}
        columns={[
          { key: 'r', header: 'Recipe', render: r => <div><strong>{r.id}</strong> {r.title}<div className="ne-faint ne-mono" style={{ fontSize: 'var(--ne-fs-caption)' }}>{r.path}</div></div> },
          { key: 'k', header: 'Offered as', render: r => <Badge tone={r.provisioning === 'live-root' ? 'info' : 'neutral'}>{r.provisioning === 'live-root' ? 'read-only live roots' : 'documentation and runbook'}</Badge> },
          {
            key: 'l',
            header: 'Live roots · sizing',
            render: r =>
              r.liveRoots.length ? (
                // The roots by stage/stack; their long sizing-file paths one click away instead of three wrapped lines each.
                <details className="ne-ov-details">
                  <summary>{r.liveRoots.map(root => root.replace(/^terraform\/live\//, '')).join(', ')}</summary>
                  {r.liveRoots.map(root => {
                    const file = sizing.find(x => `terraform/live/${x.stage}/${x.stack}` === root)?.sizingFile;
                    return (
                      <div key={root} className="ne-mono" style={{ overflowWrap: 'anywhere' }}>
                        {file ?? root}
                      </div>
                    );
                  })}
                </details>
              ) : (
                <span className="ne-faint">{r.caps ? `none: cap ${Object.entries(r.caps).map(([k, v]) => `${k} ${v}`).join(' · ')}` : 'none'}</span>
              ),
          },
          { key: 'b', header: 'Runbooks', render: r => (r.runbooks.length ? <span className="ne-mono" style={{ fontSize: '0.75rem' }}>{r.runbooks.map(p => p.split('/').pop()).join(', ')}</span> : <span className="ne-faint">none yet</span>) },
        ]}
      />
    </Card>
  );
}

function Wizard({ data, onCreated }: { data: RecipesResponse; onCreated: () => void }) {
  const now = usePortalNow();
  const meta = useMeta();
  const call = useBackend();
  const [recipe, setRecipe] = useState<RecipeDefinition>(data.recipes[0]);
  const [input, setInput] = useState<ProvisioningRequestInput>(() => defaultsFor(data.recipes[0], data, now));
  const [budget, setBudget] = useState('');
  const filters = useGet<FilterOptions>('/filters');
  const projectName = (id: string) => filters.data?.projects.find(p => p.id === id)?.name ?? id;
  // A rate book is optional (W1-P6): without one the backend prices the estimate at the Nebius list price.
  const canReadRates = meta.data?.permissions['nebius.commercial.rate.read'];
  // Without the commercial read permission no estimate is asked for (it would answer 403); while /meta loads, it waits.
  const noRates = meta.data !== undefined && !canReadRates;
  const priced = useRef<string>();
  const [currency, setCurrency] = useState<string>();
  const budgetCurrency = currency ?? 'USD';
  const [preview, setPreview] = useState<PreviewResponse>();
  const [previewError, setPreviewError] = useState<string>();
  const [estimate, setEstimate] = useState<ScenarioEstimate>();
  const [estimateError, setEstimateError] = useState<string>();
  const [live, setLive] = useState<LivePriceState>({ status: 'idle' });
  const [liveTick, setLiveTick] = useState(0);
  const [created, setCreated] = useState<ProvisioningRequestRecord>();
  const [busy, setBusy] = useState(false);
  const [createError, setCreateError] = useState<string>();

  // The committed configuration this request is compared with: the stage's sizing file and the chosen run profile.
  const committed = useMemo(() => committedFor(data, recipe, input.stage, input.runProfile), [data, recipe, input.stage, input.runProfile]);
  const profile = committed.profile;
  const locked = (f: SizingField) => setByProfile(f, profile);
  const shrink = shrinkOf(input, committed);
  const region = data.regions.find(r => r.id === input.region);
  const platforms = (region?.platforms ?? []).filter(p => (recipe.id === 'training-capacity' ? p.ib_preset && p.fabric : recipe.id === 'sandbox-inference' ? p.single_gpu_preset : true));
  const currentPlatform = region?.platforms.find(p => p.id === (input.platform || region.default));
  const policy = data.stages[input.stage];
  const cap = recipe.stack === 'soperator' ? 0 : policy?.max_gpu_nodes[recipe.stack as 'inference' | 'training'];
  const full: ProvisioningRequestInput = { ...input, budget: budget.trim() ? { amount: budget.trim(), currency: budgetCurrency } : undefined };
  // Checked on the client first, with a message on the field. An empty reference is the backend's one error: the diff
  // and the estimate preview without it (W1-P5), the run sheet and Prepare wait for it.
  const clientErrors = useMemo(() => {
    const e = clientFieldErrors({ ...input, budget: full.budget }, budget);
    if (!input.requestRef) delete e.requestRef;
    return e;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(input), budget, budgetCurrency]);
  const fieldError = (f: string) => clientErrors[f] ?? preview?.issues.find(i => i.field === f && i.severity === 'error')?.message;

  // Validate, preview and estimate on every change (debounced). The backend re-validates on create.
  // Responses to an older input are dropped, so a slow reply never overwrites a newer one.
  useEffect(() => {
    setCreated(undefined);
    const invalid = Object.keys(clientErrors);
    if (invalid.length) {
      setPreview(undefined);
      setEstimate(undefined);
      setLive({ status: 'idle', message: 'Priced once the request passes validation.' });
      setPreviewError(`Fix the highlighted field${invalid.length === 1 ? '' : 's'}: ${invalid.map(f => FIELD_LABELS[f] ?? f).join(', ')}.`);
      return undefined;
    }
    let current = true;
    // New inputs: the previous price belongs to another footprint, so it is dropped. A retry keeps it, marked as updating.
    const key = JSON.stringify(full);
    setLive(s => (priced.current === key ? pendingState(s) : { status: 'loading' }));
    priced.current = key;
    const post = <T,>(path: string) => call<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(full) });
    const t = setTimeout(async () => {
      try {
        const p = await post<PreviewResponse>('/provisioning/preview');
        if (!current) return;
        setPreview(p);
        setPreviewError(undefined);
        if (!p.change) {
          setEstimate(undefined);
          setLive({ status: 'idle', message: 'Priced once the request passes validation.' });
          return;
        }
      } catch (e) {
        if (current) {
          setPreview(undefined);
          setPreviewError(readableInputError((e as Error).message));
          setLive({ status: 'idle', message: 'Priced once the request passes validation.' });
        }
        return;
      }
      // Live list price runs beside the rate-book estimate; each reply is dropped if the input moved on.
      post<LivePriceResponse>('/provisioning/live-price')
        .then(r => current && setLive({ status: 'ready', response: r }))
        .catch(e => current && setLive(failureState(e)));
      if (meta.loading) return; // asked again once the permissions are in
      if (noRates) {
        setEstimate(undefined);
        setEstimateError('You do not have the commercial permissions needed for an estimate.');
        return;
      }
      try {
        const e = await post<ScenarioEstimate>('/provisioning/estimate');
        if (!current) return;
        setEstimate(e);
        setEstimateError(undefined);
      } catch (e) {
        if (!current) return;
        setEstimate(undefined);
        setEstimateError(e instanceof ApiError && e.permissionDenied ? 'You do not have the commercial permissions needed for an estimate.' : (e as Error).message);
      }
    }, 300);
    return () => {
      current = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(full), call, liveTick, clientErrors, noRates, meta.loading]);

  const errors = preview?.issues.filter(i => i.severity === 'error') ?? [];
  const builtInPrice = estimate?.rateBook.id === LIVE_LIST_BOOK_ID;
  const quotaStops = preview?.quotaCheck?.lines.some(l => l.state !== 'ok') ?? false;
  const switchTo = (patch: Partial<ProvisioningRequestInput>) => setInput(s => ({ ...s, ...patch }));
  const gpuPlatform = preview?.availability?.platform;
  const advisorSwitches = (preview?.availability?.alternatives ?? [])
    .map(o => ({ o, s: gpuPlatform ? switchFor(o, input, gpuPlatform, data.regions) : undefined }))
    .filter((x): x is { o: (typeof x)['o']; s: NonNullable<(typeof x)['s']> } => Boolean(x.s));
  const valid = Boolean(preview?.change) && errors.length === 0;
  const steps = stepStates({ valid, estimate: Boolean(estimate), livePriced: live.status === 'ready', estimateUnavailable: noRates, created: Boolean(created) });
  const stepState = (i: number) => steps[i];
  const set = <K extends keyof ProvisioningRequestInput>(k: K, v: ProvisioningRequestInput[K]) => setInput(s => ({ ...s, [k]: v }));
  const choose = (r: RecipeDefinition) => {
    setRecipe(r);
    setInput(defaultsFor(r, data, now));
  };
  const canRequest = meta.data?.permissions['nebius.provisioning.request.create'];

  const prepare = async () => {
    setBusy(true);
    setCreateError(undefined);
    try {
      const rec = await call<ProvisioningRequestRecord>('/provisioning/requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: full, baseHashes: preview?.baseHashes ?? {} }),
      });
      setCreated(rec);
      onCreated();
    } catch (e) {
      setCreateError(readableInputError((e as Error).message));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <ol className="ne-steps" aria-label="Provisioning steps">
        {STEPS.map((s, i) => (
          <li key={s} data-state={stepState(i)} aria-current={stepState(i) === 'current' ? 'step' : undefined}>
            {s}
          </li>
        ))}
      </ol>
      <div className="ne-grid ne-grid-3" role="radiogroup" aria-label="Recipe" style={{ marginBottom: 14 }}>
        {data.recipes.map((r, i) => (
          <button
            key={r.id}
            type="button"
            role="radio"
            aria-checked={recipe.id === r.id}
            // A radio group is one tab stop; arrow keys move and select (WAI-ARIA radio group).
            tabIndex={recipe.id === r.id ? 0 : -1}
            className="ne-card"
            onClick={() => choose(r)}
            onKeyDown={e => {
              const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
              if (!step) return;
              e.preventDefault();
              const n = data.recipes.length;
              const next = (i + step + n) % n;
              choose(data.recipes[next]);
              (e.currentTarget.parentElement?.children[next] as HTMLElement | undefined)?.focus();
            }}
            style={{
              textAlign: 'left',
              padding: '14px 16px',
              cursor: 'pointer',
              font: 'inherit',
              color: 'inherit',
              borderColor: recipe.id === r.id ? 'var(--ne-accent)' : undefined,
              boxShadow: recipe.id === r.id ? '0 0 0 1px var(--ne-accent)' : undefined,
            }}
          >
            <div className="ne-between">
              <strong style={{ fontSize: '0.875rem' }}>{r.title}</strong>
              <Badge tone="info">{r.stack}</Badge>
            </div>
            <div className="ne-muted" style={{ fontSize: '0.78125rem', marginTop: 6 }}>
              {r.summary}
            </div>
          </button>
        ))}
      </div>

      <div className="ne-grid ne-grid-main">
        <Card title="1 · Configure" icon="provision">
          <div className="ne-grid ne-grid-2" style={{ gap: 12 }}>
            <Field label="Stage" htmlFor="pv-stage" hint={policy ? `GPU cap ${cap ?? '—'} · TTL ${policy.require_ttl_label ? 'required' : 'not required'}` : undefined} error={fieldError('stage')}>
              {/* A stage has its own sizing file: its committed values replace the fields, never the previous stage's (W1-P1). */}
              <select id="pv-stage" className="ne-select" value={input.stage} onChange={e => { const stage = e.target.value; setInput(s => prefill({ ...s, stage }, committedFor(data, recipe, stage), recipe.capacityTypes)); }}>
                {recipe.stages.map(s => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </Field>
            {committed.profiles.length && recipe.stack !== 'soperator' ? (
              <Field
                label="Run profile"
                htmlFor="pv-profile"
                hint={profile ? `Planned with make plan PROFILE=${profile.name}; its vars (platform/profiles) override the sizing file` : 'none: the stage\'s sizing file alone'}
                error={fieldError('runProfile')}
              >
                <select id="pv-profile" className="ne-select" value={input.runProfile ?? ''} onChange={e => { const name = e.target.value || undefined; setInput(s => prefill(s, committedFor(data, recipe, s.stage, name), recipe.capacityTypes)); }}>
                  <option value="">none (sizing file)</option>
                  {committed.profiles.map(p => (
                    <option key={p.name} value={p.name}>
                      {p.name} ({p.region})
                    </option>
                  ))}
                </select>
              </Field>
            ) : null}
            <Field label="Region" htmlFor="pv-region" hint={profile ? `Run profile ${profile.name} is for ${profile.region}` : region?.note ?? 'Exported as NEBIUS_REGION at plan time; not written to the sizing file.'} error={fieldError('region')}>
              <select id="pv-region" className="ne-select" value={input.region} disabled={Boolean(profile)} onChange={e => setInput(s => ({ ...s, region: e.target.value, platform: null, fabric: null }))}>
                {data.regions.map(r => (
                  <option key={r.id}>{r.id}</option>
                ))}
              </select>
            </Field>
            {recipe.stack !== 'soperator' ? (
              <>
                <Field label={<>GPU platform · preset<Origin field="platform" input={input} committed={committed} /></>} htmlFor="pv-platform" hint="From platform/regions.yaml" error={fieldError('platform')}>
                  <select id="pv-platform" className="ne-select" value={input.platform ?? ''} disabled={locked('platform')} onChange={e => setInput(s => ({ ...s, platform: e.target.value || null, fabric: null }))}>
                    <option value="">Region default ({region?.default})</option>
                    {input.platform && !platforms.some(p => p.id === input.platform) ? <option value={input.platform}>{input.platform}</option> : null}
                    {platforms.map(p => (
                      <option key={p.id} value={p.id}>
                        {p.id} · {recipe.id === 'training-capacity' ? `${p.ib_preset} · ${p.fabric}` : p.single_gpu_preset}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={<>GPU nodes<Origin field="gpuNodeCount" input={input} committed={committed} /></>} htmlFor="pv-gpus" hint={`Stage cap ${cap}; ${recipe.id === 'training-capacity' ? '8 GPUs per node' : '1 GPU per node'}`} error={fieldError('gpuNodeCount')}>
                  <input id="pv-gpus" className="ne-input ne-num" type="number" min={0} max={64} value={input.gpuNodeCount} disabled={locked('gpuNodeCount')} onChange={e => set('gpuNodeCount', Math.max(0, Math.min(64, Number(e.target.value) || 0)))} />
                </Field>
                <Field label={<>Capacity type<Origin field="capacityType" input={input} committed={committed} /></>} htmlFor="pv-cap" error={fieldError('capacityType')}>
                  <select id="pv-cap" className="ne-select" value={input.capacityType} disabled={locked('capacityType')} onChange={e => set('capacityType', e.target.value as ProvisioningRequestInput['capacityType'])}>
                    {recipe.capacityTypes.map(c => (
                      <option key={c}>{c}</option>
                    ))}
                  </select>
                </Field>
                {input.capacityType === 'reserved' ? (
                  <Field label="Reservation policy" htmlFor="pv-res" hint="Reservation IDs are passed at plan time, never committed" error={fieldError('reservationPolicy')}>
                    <select id="pv-res" className="ne-select" value={input.reservationPolicy ?? ''} onChange={e => set('reservationPolicy', (e.target.value || undefined) as ProvisioningRequestInput['reservationPolicy'])}>
                      <option value="">Choose…</option>
                      <option value="AUTO">AUTO (reserved first, on-demand burst)</option>
                      <option value="STRICT">STRICT (reserved only)</option>
                    </select>
                  </Field>
                ) : null}
                {recipe.id === 'training-capacity' ? (
                  <Field label={<>InfiniBand fabric<Origin field="fabric" input={input} committed={committed} /></>} htmlFor="pv-fabric" hint="infiniband_fabric; the fabrics of the platform in platform/regions.yaml" error={fieldError('fabric')}>
                    <select id="pv-fabric" className="ne-select" value={input.fabric ?? ''} disabled={locked('fabric')} onChange={e => set('fabric', e.target.value || null)}>
                      <option value="">Platform default ({currentPlatform?.fabric ?? 'none'})</option>
                      {(currentPlatform?.fabrics ?? []).map(f => (
                        <option key={f} value={f}>
                          {f}
                        </option>
                      ))}
                    </select>
                  </Field>
                ) : null}
                <div>
                  <Field
                    label={<>Shared filesystem (GiB)<Origin field="filestoreSizeGib" input={input} committed={committed} /></>}
                    htmlFor="pv-fs"
                    hint={`filestore_size_gib in the sizing file${committed.file.filestoreSizeGib !== undefined ? ` (committed: ${committed.file.filestoreSizeGib.toLocaleString('en-US')} GiB)` : ''}; a volume can grow, never shrink`}
                    error={fieldError('filestoreSizeGib')}
                  >
                    <input id="pv-fs" className="ne-input ne-num" type="number" min={0} value={input.filestoreSizeGib ?? ''} disabled={locked('filestoreSizeGib')} onChange={e => set('filestoreSizeGib', e.target.value === '' ? undefined : Math.max(0, Number(e.target.value)))} />
                  </Field>
                  {shrink ? (
                    // W1-P2: a shrink replaces the filesystem and loses its data; reset, or say it is meant.
                    <div className="ne-stack" style={{ gap: 6, marginTop: 6 }}>
                      <button type="button" className="ne-btn ne-btn-sm" onClick={() => setInput(s => ({ ...s, filestoreSizeGib: shrink.from, confirmShrink: undefined }))}>
                        Reset to {shrink.from.toLocaleString('en-US')} GiB
                      </button>
                      <label htmlFor="pv-shrink" className="ne-row ne-cap-check" style={{ fontSize: '0.8125rem' }}>
                        <input id="pv-shrink" type="checkbox" checked={Boolean(input.confirmShrink)} onChange={e => set('confirmShrink', e.target.checked || undefined)} />
                        I intend to shrink/replace the shared filesystem (its data is lost)
                      </label>
                    </div>
                  ) : null}
                </div>
              </>
            ) : null}
            <Field label="Approved runtime (hours)" htmlFor="pv-rt" hint="Hours the resources exist, including warm-up and teardown; the estimate and the live price use this figure">
              <input id="pv-rt" className="ne-input ne-num" type="number" min={0.25} step={0.25} value={input.runtimeHours} onChange={e => set('runtimeHours', Math.max(0.25, Number(e.target.value) || 0.25))} />
            </Field>
            <Field label="TTL (nip-ttl-expires, UTC)" htmlFor="pv-ttl" hint={policy?.require_ttl_label ? 'Required in this stage; must end inside the approved run' : 'Optional in this stage'} error={fieldError('ttlExpires')}>
              <input
                id="pv-ttl"
                className="ne-input"
                type="datetime-local"
                value={input.ttlExpires ? input.ttlExpires.slice(0, 16) : ''}
                onChange={e => set('ttlExpires', e.target.value ? `${e.target.value}:00Z` : undefined)}
              />
            </Field>
            <Field label="Owner (nip-owner)" htmlFor="pv-owner" error={fieldError('owner')}>
              <input id="pv-owner" className="ne-input" value={input.owner} aria-invalid={fieldError('owner') ? 'true' : undefined} onChange={e => set('owner', e.target.value)} />
            </Field>
            <Field label="Request reference (nip-run)" htmlFor="pv-ref" hint="Ticket, date or run id" error={fieldError('requestRef')}>
              <input id="pv-ref" className="ne-input" placeholder="ticket-123" value={input.requestRef} aria-invalid={fieldError('requestRef') ? 'true' : undefined} onChange={e => set('requestRef', e.target.value)} />
            </Field>
            <Field label="Approved budget (advisory)" htmlFor="pv-budget" hint="Recorded with the request; budgets notify, quotas stop (docs/cost.md)" error={fieldError('budget')}>
              <div className="ne-row" style={{ flexWrap: 'nowrap' }}>
                <input id="pv-budget" className="ne-input ne-num" style={{ flex: 1 }} inputMode="decimal" placeholder="e.g. 500" value={budget} aria-invalid={fieldError('budget') ? 'true' : undefined} aria-describedby={fieldMessageId('pv-budget')} onChange={e => setBudget(e.target.value)} />
                <select className="ne-select" aria-label="Budget currency" value={budgetCurrency} onChange={e => setCurrency(e.target.value)}>
                  {['USD', 'EUR'].map(c => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </div>
            </Field>
          </div>
        </Card>

        <div className="ne-stack" style={{ gap: 14 }}>
          <Card title="2 · Validate" icon="check">
            {previewError ? (
              <Callout tone={preview || Object.keys(clientErrors).length ? 'danger' : 'info'}>{previewError}</Callout>
            ) : !preview ? (
              <span className="ne-muted">Validating…</span>
            ) : (
              <ul style={{ listStyle: 'none', padding: 0, margin: 0 }} className="ne-stack" aria-live="polite">
                {preview.issues.map((i, k) => (
                  <li key={k} style={{ display: 'flex', gap: 8 }}>
                    <Badge tone={i.severity === 'error' ? 'danger' : i.severity === 'warning' ? 'warn' : 'info'}>{i.severity}</Badge>
                    {/* minWidth 0 and anywhere-wrap: a long source (a docs URL) never widens the page at 390 px. */}
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: '0.8125rem', overflowWrap: 'anywhere' }}>{i.message}</div>
                      <div className="ne-faint ne-mono" style={{ fontSize: 'var(--ne-fs-caption)', overflowWrap: 'anywhere' }}>
                        {i.source}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          {preview?.change && preview.availability ? (
            <AvailabilityCard a={preview.availability} switches={advisorSwitches.map(({ o, s }) => ({ key: `${o.region}/${o.fabric}/${o.capacityType}`, label: s.label, onClick: () => switchTo(s.patch) }))} />
          ) : null}
          {preview?.change && preview.reservations ? <ReservationsCard r={preview.reservations} /> : null}
        </div>
      </div>

      {/* Full width under Configure / Validate (G5.5): in the side column its quota ids wrapped line by line and the status badge was cut. */}
      {preview?.change ? (
        <div className="ne-section">
          <QuotaNeedsCard
            check={preview.quotaCheck}
            needs={preview.change.quota}
            fitsIn={preview.fitsIn}
            onUseRegion={(r, platform) => switchTo({ region: r, platform: data.regions.find(x => x.id === r)?.default === platform ? null : platform, fabric: null })}
            pending={quotaStops || input.quotaRequestPending ? { checked: Boolean(input.quotaRequestPending), onChange: v => set('quotaRequestPending', v || undefined) } : undefined}
          />
        </div>
      ) : null}

      {preview?.change && errors.length ? (
        <div className="ne-section">
          <Callout tone="warn" title={`Prepare is blocked by ${errors.length} error${errors.length === 1 ? '' : 's'} (step 2)`}>
            The diff and the estimate below show what this request would change and cost; fix the errors to prepare it.
          </Callout>
        </div>
      ) : null}

      {preview?.change ? (
        <div className="ne-section ne-grid ne-grid-main">
          <Card title="3 · Preview intended file changes" icon="doc">
            {preview.change.files.length ? (
              preview.change.files.map(f => <DiffView key={f.path} diff={f.diff || `# ${f.path}: no change (values already match)\n`} label={`Diff of ${f.path}`} />)
            ) : (
              <EmptyState title="No file changes">This recipe uses the committed configuration unchanged; the run sheet is the deliverable.</EmptyState>
            )}
            <h3 className="ne-section-title" style={{ marginTop: 14 }}>Run sheet (for the operator; never executed by the portal)</h3>
            {/* Empty until a request reference names the run; the first note says so. */}
            {preview.change.runSheet.length ? (
              // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- WCAG scrollable-region-focusable
              <pre className="ne-code" tabIndex={0} aria-label="Run sheet">{preview.change.runSheet.join('\n')}</pre>
            ) : null}
            <ul className="ne-muted" style={{ fontSize: '0.78125rem', paddingLeft: 18, margin: '10px 0 0' }}>
              {preview.change.notes.map(n => (
                <li key={n}>{n}</li>
              ))}
            </ul>
            {preview.commit ? <p className="ne-faint" style={{ fontSize: 'var(--ne-fs-caption)' }}>Previewed against commit <code>{preview.commit.slice(0, 12)}</code>.</p> : null}
          </Card>
          <Card title="4 · Estimate and pricing coverage" icon="commercial">
            {estimate ? (
              <div className="ne-stack">
                <Badge tone="warn" wrap>{DRAFT_QUOTE_LABEL}</Badge>
                <KeyValue
                  items={[
                    builtInPrice
                      ? ['Price source', `${estimate.rateBook.name}: no rate book is in use (optional; add one on Commercial Scenarios → Rate books)`]
                      : [RATE_BOOK_LABEL.charAt(0).toUpperCase() + RATE_BOOK_LABEL.slice(1), `${estimate.rateBook.name} (${estimate.rateBook.kind})`],
                    // No total built on an unpriced compute line; a total names the lines it leaves out (W1-P9).
                    ...(estimateHeadline(estimate.footprints[1]).state === 'incomplete'
                      ? [['Hourly (requested)', estimateHeadline(estimate.footprints[1]).text] as [string, string]]
                      : ([
                          ['Hourly (requested)', `${fmtMoney(estimate.footprints[1].hourly)}${estimateHeadline(estimate.footprints[1]).state === 'partial' ? ` · ${estimateHeadline(estimate.footprints[1]).text}` : ''}`],
                          ['Floor / workload', `${fmtMoney(estimate.footprints[1].hourlyFloor)} / ${fmtMoney(estimate.footprints[1].hourlyWorkload)}`],
                          [`Run (${estimate.footprints[1].runHours} h approved runtime)`, fmtMoney(estimate.footprints[1].runPeriod)],
                        ] as [string, string][])),
                    ['Coverage', estimate.coverage.complete ? <Badge key="c" tone="ok">all components priced</Badge> : <Badge key="c" tone="warn">{estimate.coverage.issues.filter(i => i.footprint === 'expected').length} component(s) unpriced</Badge>],
                  ]}
                />
                {estimate.coverage.issues
                  .filter(i => i.footprint === 'expected')
                  .map((i, k) => (
                    <div key={k} className="ne-muted" style={{ fontSize: '0.75rem' }}>
                      {i.status}: {i.description}
                    </div>
                  ))}
                {estimate.coverage.variablePriceComponents.length ? <Callout tone="warn">Variable spot price: {estimate.coverage.variablePriceComponents.join(', ')}.</Callout> : null}
                <a href="#pv-live-price" className="ne-faint" style={{ fontSize: '0.75rem' }}>
                  Nebius live price (billing calculator) and comparison below
                </a>
              </div>
            ) : (
              <Callout tone="info">{estimateError ?? 'Estimating…'}</Callout>
            )}
          </Card>
        </div>
      ) : null}

      {!preview?.change ? (
        <div className="ne-section">
          <Callout tone="info" title="3 · Preview changes and 4 · Estimate">
            Shown once the request passes validation (step 2).
          </Callout>
        </div>
      ) : null}

      {preview?.change ? (
        <div className="ne-section">
          <LivePricePanel
            id="pv-live-price"
            projectName={projectName}
            onRetry={() => setLiveTick(t => t + 1)}
            // The built-in list price is the live price itself: not compared with itself (W1-P6).
            rateBook={estimate && !builtInPrice ? { name: estimate.rateBook.name, kind: estimate.rateBook.kind } : undefined}
            rows={[
              {
                key: 'requested',
                label: 'requested footprint',
                state: live,
                book: builtInPrice ? undefined : estimate?.footprints.find(f => f.footprint === 'expected')?.hourly,
                runHours: input.runtimeHours,
              },
            ]}
          />
        </div>
      ) : null}

      <div className="ne-section">
        <Card title="5 · Prepare the reviewed change" icon="check">
          <div className="ne-between">
            <div className="ne-muted" style={{ maxWidth: 760, fontSize: '0.8125rem' }}>
              Records the request in the portal and produces a <code>git apply</code>-able patch. You open the pull request yourself; the portal writes
              nothing outside its own database.
            </div>
            <div className="ne-row">
              <button type="button" className="ne-btn ne-btn-primary" disabled={!valid || busy || !canRequest || Boolean(created)} onClick={prepare} title={!canRequest ? 'Requires nebius.provisioning.request.create' : created ? 'Prepared: change an input to prepare another request' : undefined}>
                <Icon name="check" size={15} /> Prepare reviewed change
              </button>
            </div>
          </div>
          {createError ? <div style={{ marginTop: 10 }}><Callout tone="danger" title="Not prepared">{createError}</Callout></div> : null}
          {created ? <div style={{ marginTop: 12 }}><CreatedRequest rec={created} /></div> : null}
        </Card>
      </div>

      <div className="ne-section">
        <CiPlanStatus />
      </div>
    </>
  );
}

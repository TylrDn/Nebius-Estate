import { Fragment, useState } from 'react';
import { errorSummary, plainError } from '@internal/nebius-domain';
import type { CapabilityStatus } from '@internal/nebius-domain';
import { Badge, Card, EmptyState, fmtAgo, fmtTime, Segmented, StatusPill, TALL_TABLE_ROWS } from '../../ui';
import { countStates, DEFAULT_GRANT_HINT, failingProjects, groupCapabilities, isFlaky, lastSuccessOf, needsAttention, needsAttentionOrFlaky, verifiedOf } from './model';
import { HealthCell, HintText } from './parts';

const COLUMNS = 6;

function Freshness({ c, now }: { c: CapabilityStatus; now: Date }) {
  const last = lastSuccessOf(c);
  return (
    <div className="ne-stack" style={{ gap: 2 }}>
      <span title={last ? fmtTime(last) : undefined}>{last ? `success ${fmtAgo(last, now)}` : c.state === 'not-configured' ? 'not called (nothing to read)' : 'never succeeded'}</span>
      {c.lastAttempt && c.lastAttempt !== last ? (
        <span className="ne-faint" style={{ fontSize: 'var(--ne-fs-caption)' }} title={fmtTime(c.lastAttempt)}>
          {`tried ${fmtAgo(c.lastAttempt, now)}`}
        </span>
      ) : null}
      {c.stale ? <Badge tone="warn">stale data kept</Badge> : null}
    </div>
  );
}

function Detail({ c, open, onToggle }: { c: CapabilityStatus; open: boolean; onToggle: () => void }) {
  const hint = c.hint ?? (c.state === 'permission-denied' ? DEFAULT_GRANT_HINT : undefined);
  const failing = failingProjects(c);
  return (
    <div className="ne-u1-detail">
      {failing.map((f, i) => (
        <div key={`${i}:${f.name}`} className="ne-u1-err">
          {`Failing in ${f.name}: ${f.state}${f.error ? ` (${errorSummary(f.error)})` : ''}`}
        </div>
      ))}
      {hint ? (
        <div>
          <HintText hint={hint} />
        </div>
      ) : null}
      {c.lastError && c.state !== 'ok' ? <div className="ne-faint ne-mono ne-u1-err">{plainError(c.lastError)}</div> : null}
      {c.drift?.length ? (
        <div>
          <span className="ne-muted">Drift from the documented contract:</span>
          <ul className="ne-u1-list">
            {c.drift.map(d => (
              <li key={d} className="ne-mono">
                {d}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {c.perProject?.length ? (
        <button type="button" className="ne-btn ne-btn-sm ne-btn-ghost" aria-expanded={open} aria-controls={open ? `u1-pp-${c.id}` : undefined} onClick={onToggle}>
          {open ? 'Hide' : 'Show'} per project ({c.perProject.length})
        </button>
      ) : null}
      {!hint && !c.drift?.length && !c.perProject?.length && !(c.lastError && c.state !== 'ok') ? <span className="ne-faint">nothing to report</span> : null}
    </div>
  );
}

/**
 * Every read-only API call this deployment's identity makes, grouped by service area, with its
 * outcome at the last sync: what answered (and how many items), what was refused and what to
 * grant, what drifted from the documented contract, and what is kept from an earlier sync.
 */
export function CapabilityGroups({ capabilities, now, outages }: { capabilities: CapabilityStatus[]; now: Date; outages?: ReadonlySet<string> }) {
  const [open, setOpen] = useState<string>();
  const attention = (c: CapabilityStatus) => needsAttentionOrFlaky(c, outages);
  const problems = capabilities.filter(attention).length;
  // Flaky: answering now, but failed on its own at least twice in the last 24 h (a shared outage is not counted, G1.6).
  const flaky = capabilities.filter(c => isFlaky(c, outages) && !needsAttention(c)).length;
  const [show, setShow] = useState<'all' | 'attention'>('all');
  const groups = groupCapabilities(show === 'attention' ? capabilities.filter(attention) : capabilities);
  return (
    <Card
      title="This identity, at the last sync"
      icon="integrations"
      flush
      actions={
        <>
          <span className="ne-row" style={{ gap: 4 }} role="group" aria-label="Capabilities by state">
            {countStates(capabilities).map(([state, n]) => (
              <StatusPill key={state} state={state} label={`${n} ${state.replace(/-/g, ' ')}`} />
            ))}
          </span>
          <Segmented
            label="Which capabilities to show"
            value={show}
            onChange={setShow}
            options={[
              { id: 'all', label: `All ${capabilities.length}` },
              { id: 'attention', label: `Needs attention ${problems}${flaky ? ` (${flaky} flaky)` : ''}` },
            ]}
          />
        </>
      }
      footer={<HintText hint="Every call is a documented read (GET; the billing calculator's estimate is the only POST and creates nothing). A refused call names the role to grant (docs/credentials.md); it is retried on the next sync. Health covers the runs recorded in the last 24 h." />}
    >
      {groups.length === 0 ? (
        <EmptyState title="Nothing needs attention" icon="check">
          Every capability answered at the last sync.
        </EmptyState>
      ) : (
        // A long list scrolls in its own viewport-high box on wide screens, so the column headers stay in view.
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- WCAG scrollable-region-focusable: the table may scroll
        <div className={`ne-table-wrap${groups.reduce((n, g) => n + g.items.length, 0) >= TALL_TABLE_ROWS ? ' ne-table-wrap-tall' : ''}`} tabIndex={0} role="region" aria-label="API capabilities by service">
          {/* Stacks into labelled cells on a phone like the other tables here (G1.11): the role to grant stays on screen. */}
          <table className="ne-table ne-table-compact ne-table-stack ne-u1-caps">
            <caption className="ne-sr-only">API capabilities by service area</caption>
            <thead>
              <tr>
                <th scope="col">Capability · documented API</th>
                <th scope="col">State</th>
                <th scope="col" className="ne-right">
                  Items
                </th>
                <th scope="col">Freshness</th>
                <th scope="col">Health (24 h)</th>
                <th scope="col">Role to grant · last error · drift</th>
              </tr>
            </thead>
            {groups.map(g => (
              <tbody key={g.service}>
                <tr className="ne-u1-group">
                  <th scope="rowgroup" colSpan={COLUMNS}>
                    <span className="ne-row" style={{ gap: 6 }}>
                      <span>{g.label}</span>
                      <span className="ne-faint" style={{ fontWeight: 500 }}>
                        {`${g.items.length} ${g.items.length === 1 ? 'call' : 'calls'}`}
                      </span>
                      {g.counts
                        .filter(([s]) => s !== 'ok')
                        .map(([s, n]) => (
                          <StatusPill key={s} state={s} label={`${n} ${s.replace(/-/g, ' ')}`} />
                        ))}
                    </span>
                  </th>
                </tr>
                {g.items.map(c => (
                  <Fragment key={c.id}>
                    <tr data-state={c.state}>
                      <td className="ne-u1-cap" data-label="Capability">
                        <div style={{ fontWeight: 600 }}>{c.title}</div>
                        <div className="ne-mono ne-faint ne-u1-path">
                          {c.method} {c.path}
                        </div>
                        <div className="ne-faint ne-u1-meta">
                          {`${c.scope} scope`}
                          {verifiedOf(c) ? (
                            // The same date as the matrix: the later of the catalog check and today's answer (G1.16).
                            <span title={[verifiedOf(c)!.checked ? `Checked on a live account with project-level viewer on ${verifiedOf(c)!.checked}` : '', verifiedOf(c)!.answered ? `answered this deployment on ${verifiedOf(c)!.answered}` : ''].filter(Boolean).join('; ')}>{` · verified ${verifiedOf(c)!.date}`}</span>
                          ) : null}
                        </div>
                      </td>
                      <td data-label="State">
                        <StatusPill state={c.state} />
                      </td>
                      <td className="ne-right ne-num" data-label="Items">{c.items ?? <span className="ne-faint">not counted</span>}</td>
                      <td data-label="Freshness">
                        <Freshness c={c} now={now} />
                      </td>
                      <td data-label="Health (24 h)">
                        <HealthCell health={c.health} latencyMs={c.latencyMs} outages={outages} />
                      </td>
                      <td className="ne-u1-detail-cell" data-label="Role to grant · last error · drift">
                        <Detail c={c} open={open === c.id} onToggle={() => setOpen(open === c.id ? undefined : c.id)} />
                      </td>
                    </tr>
                    {open === c.id && c.perProject?.length ? (
                      <tr id={`u1-pp-${c.id}`} className="ne-u1-pp">
                        <td colSpan={COLUMNS}>
                          <ul className="ne-u1-pp-list" aria-label={`${c.title} per project`}>
                            {c.perProject.map(p => (
                              <li key={p.id}>
                                <span title={p.id} style={{ fontWeight: 600 }}>
                                  {p.name ?? p.id}
                                </span>
                                <StatusPill state={p.state} />
                                <span className="ne-num">{p.items !== undefined ? `${p.items} items` : ''}</span>
                                {p.error ? <span className="ne-faint ne-mono ne-u1-err">{plainError(p.error)}</span> : null}
                              </li>
                            ))}
                          </ul>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                ))}
              </tbody>
            ))}
          </table>
        </div>
      )}
    </Card>
  );
}

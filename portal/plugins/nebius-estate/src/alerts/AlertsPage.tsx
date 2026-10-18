import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import type { AlertDetailResponse, AlertNote, AlertsResponse, AlertView } from '@internal/nebius-domain';
import { alertValueText, docsHref } from '@internal/nebius-domain';
import {
  Async,
  Badge,
  Callout,
  Card,
  Column,
  DataTable,
  Drawer,
  EmptyState,
  Field,
  filterQuery,
  fmtAgo,
  fmtTime,
  Icon,
  Markdown,
  PageShell,
  ProjectName,
  StatusPill,
  Tabs,
  useBackend,
  useGet,
  useGlobalFilter,
  useProjectNames,
  usePortalNow,
} from '../ui';
import { BrowserNotifier, clearedBeforeFiring, docsLink, newlyFiring, notificationsEnabled, runbookLink, seenKey, setNotificationsEnabled, SEVERITY_SORT_LABELS, SEVERITY_TONE, severityRank, sinceOf, SOURCE_LABEL, subjectText } from './model';
import { RulesTable } from './RulesTable';

type Tab = 'firing' | 'pending' | 'resolved' | 'rules';
const TABS: Tab[] = ['firing', 'pending', 'resolved', 'rules'];
const POLL_MS = 60_000;

/** Alerts inbox: firing, pending and resolved alerts from the shared rule files, each with a guided fix. */
export function AlertsPage() {
  const [filter] = useGlobalFilter();
  const [params, setParams] = useSearchParams();
  const tab = (TABS as string[]).includes(params.get('tab') ?? '') ? (params.get('tab') as Tab) : 'firing';
  const selected = params.get('alert') ?? undefined;
  const location = useLocation();
  const navigate = useNavigate();
  const set = (k: string, v?: string, opts: { push?: boolean } = {}) =>
    setParams(
      p => {
        const n = new URLSearchParams(p);
        if (v) n.set(k, v);
        else n.delete(k);
        return n;
      },
      opts.push ? { state: { alertDrawer: true } } : { replace: true },
    );
  // Opening the drawer is a history entry, so Back closes it; closing one opened here goes back to that entry.
  const openAlert = (id: string) => set('alert', id, { push: !selected });
  const closeAlert = () => ((location.state as { alertDrawer?: boolean } | null)?.alertDrawer ? navigate(-1) : set('alert'));
  // The whole global filter: project, region and stage (G1.2).
  const load = useGet<AlertsResponse>(`/alerts${filterQuery(filter)}`);
  const now = usePortalNow();
  const [notify, setNotify] = useState(() => notificationsEnabled() && BrowserNotifier.permission() === 'granted');
  useBrowserNotifications(load.data?.alerts, notify, load.reload);

  return (
    <PageShell
      title="Alerts"
      subtitle="Rules from platform/alerts (the same files in-cluster Prometheus loads) and the portal's own rules, evaluated after every sync. Each alert links its evidence and a guided fix; the portal never applies one."
      actions={<NotifyToggle on={notify} onChange={setNotify} />}
    >
      <Async load={load} rows={6}>
        {a => (
          <>
            <p className="ne-muted" style={{ marginTop: 0 }}>
              {a.lastEvalAt ? (
                <>
                  Evaluated after each sync; last evaluation {fmtAgo(a.lastEvalAt, now)} ({fmtTime(a.lastEvalAt)}).{' '}
                </>
              ) : (
                'Not evaluated yet: rules run after each sync, and the first one since start-up is still running. '
              )}
              {a.counts.muted ? `${a.counts.muted} open alert(s) muted (local notes). ` : null}
              {a.filterNote ? `${a.filterNote}. ` : null}
              <Link to="/evidence?doc=runbooks%2Ffleet-alerts.md">How alerts work →</Link> · <Link to={docsHref('/observability/monitoring')}>Nebius docs: metrics →</Link>
            </p>
            {a.problems.length ? (
              <Callout tone="warn" title="Some rule files could not be read">
                <ul className="ne-ov-mini">
                  {a.problems.map(p => (
                    <li key={`${p.file}:${p.message}`}>
                      {p.file}: {p.message}
                    </li>
                  ))}
                </ul>
              </Callout>
            ) : null}
            <Tabs
              label="Alert state"
              value={tab}
              onChange={v => set('tab', v === 'firing' ? undefined : v)}
              tabs={[
                { id: 'firing', label: 'Firing', count: a.counts.firing },
                { id: 'pending', label: 'Pending', count: a.counts.pending },
                { id: 'resolved', label: 'Resolved', count: a.counts.resolved },
                { id: 'rules', label: 'Rules', count: a.rules.length },
              ]}
            />
            <div className="ne-section" style={{ marginTop: 12 }}>
              {tab === 'rules' ? <RulesTable rules={a.rules} /> : <Inbox alerts={a.alerts.filter(x => x.state === tab)} state={tab} now={now} selected={selected} onSelect={openAlert} />}
            </div>
            <AlertDrawer id={selected} canAnnotate={a.canAnnotate} onClose={closeAlert} onChanged={load.reload} now={now} />
          </>
        )}
      </Async>
    </PageShell>
  );
}

/** Polls while notifications are on and notifies each new firing episode once; alerts already firing when the page opens are not repeated. */
function useBrowserNotifications(alerts: AlertView[] | undefined, enabled: boolean, reload: () => void) {
  const navigate = useNavigate();
  const seen = useRef<Set<string> | null>(null);
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  useEffect(() => {
    if (!enabled) return undefined;
    const id = window.setInterval(() => reloadRef.current(), POLL_MS);
    return () => window.clearInterval(id);
  }, [enabled]);
  useEffect(() => {
    if (!alerts) return;
    if (!seen.current) {
      seen.current = new Set(alerts.filter(x => x.state === 'firing').map(seenKey));
      return;
    }
    const fresh = newlyFiring(alerts, seen.current);
    fresh.forEach(x => seen.current!.add(seenKey(x)));
    if (enabled && fresh.length) {
      void new BrowserNotifier(link => navigate(link)).notify(
        fresh.map(x => ({ alertId: x.id, ruleName: x.ruleName, severity: x.severity, state: x.state, summary: x.summary, at: x.firedAt ?? x.activeAt, link: `/alerts?alert=${x.id}` })),
      );
    }
  }, [alerts, enabled, navigate]);
}

function NotifyToggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  const [note, setNote] = useState<string>();
  const supported = BrowserNotifier.supported();
  return (
    <span className="ne-row" style={{ gap: 6 }}>
      <button
        type="button"
        className="ne-btn ne-btn-sm"
        aria-pressed={on}
        disabled={!supported}
        title={supported ? 'Notify in this browser while the portal is open' : 'This browser has no Notification API'}
        onClick={async () => {
          if (on) {
            setNotificationsEnabled(false);
            onChange(false);
            setNote(undefined);
            return;
          }
          const p = await BrowserNotifier.request();
          if (p === 'granted') {
            setNotificationsEnabled(true);
            onChange(true);
            setNote(undefined);
          } else setNote(p === 'denied' ? 'Notifications are blocked for this site in the browser settings.' : 'Notifications were not allowed.');
        }}
      >
        <Icon name="alert" size={13} /> {on ? 'Browser notifications on' : 'Notify me in this browser'}
      </button>
      {note ? <span className="ne-faint" style={{ fontSize: 12 }} role="status">{note}</span> : null}
    </span>
  );
}

function Inbox({ alerts, state, now, selected, onSelect }: { alerts: AlertView[]; state: Tab; now: Date; selected?: string; onSelect: (id: string) => void }) {
  const names = useProjectNames();
  const columns: Column<AlertView>[] = [
    { key: 'sev', header: 'Severity', render: a => <Badge tone={SEVERITY_TONE[a.severity]} dot>{a.severity}</Badge>, sortValue: a => severityRank(a.severity), sortLabels: SEVERITY_SORT_LABELS, width: 100 },
    {
      key: 'summary',
      header: 'Alert',
      render: a => (
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 600, overflowWrap: 'anywhere' }}>
            {a.summary}
            {clearedBeforeFiring(a) ? (
              <>
                {' '}
                <Badge tone="neutral" title="It went pending and cleared before its rule's `for:` ran out: it never fired.">cleared before firing</Badge>
              </>
            ) : null}
          </div>
          <div className="ne-faint" style={{ fontSize: 12 }}>
            {a.ruleName} · {SOURCE_LABEL[a.source]}
            {a.acknowledged ? ` · acknowledged by ${a.acknowledged.userRef}` : ''}
            {a.muted ? ` · muted until ${fmtTime(a.muted.until)}` : ''}
          </div>
        </div>
      ),
      sortValue: a => a.summary,
    },
    {
      key: 'scope',
      header: 'Scope',
      render: a => {
        const t = subjectText(a);
        const pid = a.subject?.projectId ?? a.projectId;
        // Names in the row, ids on hover (F1.5); the drawer prints the ids in full.
        return (
          <div style={{ overflowWrap: 'anywhere' }} title={t.ids}>
            {t.primary}
            {/* The project name breaks only between words, never at its hyphen (#64: "nbis-|labs"). */}
            {t.project ? <span className="ne-faint ne-nowrap">{t.primary ? ' · ' : ''}{pid && t.project === pid ? <ProjectName id={pid} names={names} /> : t.project}</span> : null}
            {!t.primary && !t.project ? <span className="ne-faint">whole estate</span> : null}
          </div>
        );
      },
      sortValue: a => subjectText(a).primary,
    },
    {
      key: 'since',
      header: state === 'rules' ? 'Since' : sinceOf({ activeAt: '' }, state).header,
      render: a => {
        const t = sinceOf(a, state === 'rules' ? 'firing' : state);
        return <span title={t.title}>{fmtAgo(t.at, now)}</span>;
      },
      sortValue: a => sinceOf(a, state === 'rules' ? 'firing' : state).at ?? '',
      sortKind: 'time',
    },
  ];
  const empty: Record<string, { title: string; body: string }> = {
    firing: { title: 'Nothing is firing', body: 'No rule holds right now for the projects in your scope. Pending alerts wait for their `for:` duration; the Rules tab shows what is evaluated.' },
    pending: { title: 'Nothing is pending', body: 'A condition that starts holding waits here until it has held for its rule’s `for:` duration.' },
    resolved: { title: 'No resolved alerts yet', body: 'Alerts resolve on their own when the condition no longer holds; they stay here with their history for 90 days.' },
  };
  return (
    <Card flush>
      <DataTable
        caption={`${state} alerts`}
        columns={columns}
        rows={alerts}
        rowKey={a => a.id}
        onRowClick={a => onSelect(a.id)}
        selectedKey={selected}
        empty={
          <EmptyState title={empty[state].title} icon={state === 'firing' ? 'check' : 'info'}>
            {empty[state].body}
          </EmptyState>
        }
      />
    </Card>
  );
}

function AlertDrawer({ id, canAnnotate, onClose, onChanged, now }: { id?: string; canAnnotate: boolean; onClose: () => void; onChanged: () => void; now: Date }) {
  const detail = useGet<AlertDetailResponse>(id ? `/alerts/${id}` : null);
  const d = detail.data && detail.data.alert.id === id ? detail.data : undefined;
  return (
    <Drawer
      open={Boolean(id)}
      onClose={onClose}
      title={d?.alert.summary ?? 'Alert'}
      subtitle={d ? `${d.alert.ruleName} · ${d.rule.file}${subjectText(d.alert).project ? ` · ${subjectText(d.alert).project}` : ''}` : undefined}
      badges={
        d ? (
          <>
            <Badge tone={SEVERITY_TONE[d.alert.severity]} dot>{d.alert.severity}</Badge>
            <StatusPill state={d.alert.state === 'firing' ? 'error' : d.alert.state === 'pending' ? 'pending' : 'ok'} label={d.alert.state} />
            <Badge>{SOURCE_LABEL[d.alert.source]}</Badge>
          </>
        ) : null
      }
    >
      {!id ? null : detail.error && !d ? (
        <EmptyState title="This alert could not be loaded" icon="warn">
          {detail.error.message}
        </EmptyState>
      ) : !d ? (
        <p className="ne-muted">Loading…</p>
      ) : (
        <div className="ne-fix">
          <section className="ne-fix-section">
            <h3>
              <Icon name="info" size={14} /> Evidence
            </h3>
            <p style={{ margin: '0 0 6px' }}>
              Holding since {fmtTime(d.alert.activeAt)} ({fmtAgo(d.alert.activeAt, now)})
              {d.alert.firedAt ? `; firing since ${fmtTime(d.alert.firedAt)}` : `; fires after ${d.alert.ruleFor}`}
              {d.alert.resolvedAt ? `; resolved ${fmtTime(d.alert.resolvedAt)}` : ''}. Value: <strong className="ne-num">{alertValueText(d.alert.value, d.alert.valueKind)}</strong>
              {d.alert.valueKind ? '' : ' (the result of the query below)'}.
            </p>
            {subjectText(d.alert).ids ? <p className="ne-faint ne-mono" style={{ margin: '0 0 6px', fontSize: 'var(--ne-fs-caption)', overflowWrap: 'anywhere' }}>{subjectText(d.alert).ids}</p> : null}
            <div className="ne-evidence-q">{d.alert.query}</div>
            {d.alert.evidence ? <p className="ne-muted" style={{ margin: '6px 0 0' }}>{d.alert.evidence}</p> : null}
            {d.alert.links.length ? (
              <ul style={{ marginTop: 8 }}>
                {d.alert.links.map(l => (
                  <li key={l.to}>
                    <Link to={l.to}>{l.label}</Link>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
          <GuidedFix d={d} />
          <Notes d={d} canAnnotate={canAnnotate} onChanged={() => { detail.reload(); onChanged(); }} />
          <section className="ne-fix-section">
            <h3>
              <Icon name="clock" size={14} /> History
            </h3>
            <ul className="ne-ov-mini">
              {d.history.map(h => (
                <li key={`${h.at}${h.to}`}>
                  {fmtTime(h.at)}: {h.from === 'inactive' ? 'started' : h.from} → <strong>{h.to}</strong> (value {alertValueText(h.value, d.alert.valueKind)})
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}
    </Drawer>
  );
}

function GuidedFix({ d }: { d: AlertDetailResponse }) {
  const g = d.guidedFix;
  return (
    <section className="ne-fix-section" aria-label="Guided fix">
      <h3>
        <Icon name="check" size={14} /> Guided fix
      </h3>
      <div className="ne-fix">
        <div>
          <span className="ne-label">What it means</span>
          <p style={{ margin: '2px 0 0' }}>{g.meaning}</p>
        </div>
        <div>
          <span className="ne-label">Read-only checks</span>
          <ol>
            {g.checks.map(c => (
              <li key={c}>{c}</li>
            ))}
          </ol>
        </div>
        <div>
          <span className="ne-label">Runbook</span>
          {g.runbook ? (
            <>
              {g.runbook.markdown ? (
                <Markdown className="ne-fix-runbook" content={g.runbook.markdown} transformLinkUri={href => runbookLink(g.runbook!.path, href)} />
              ) : (
                <p className="ne-muted" style={{ margin: '2px 0' }}>{g.runbook.missing}</p>
              )}
              <Link to={`/evidence?doc=${encodeURIComponent(g.runbook.path)}`}>Open {g.runbook.path} in the document viewer →</Link>
            </>
          ) : (
            <p className="ne-muted" style={{ margin: '2px 0' }}>This rule names no runbook section.</p>
          )}
        </div>
        <div>
          <span className="ne-label">Nebius documentation</span>
          <p style={{ margin: '2px 0 0' }}>
            {docsLink(g.docs) ? (
              <a href={docsLink(g.docs)} target="_blank" rel="noopener noreferrer" style={{ overflowWrap: 'anywhere' }}>
                {g.docs!.replace(/^https:\/\//, '')}
              </a>
            ) : g.docs ? (
              <span className="ne-muted">The rule's docs link is not an https URL, so it is not shown as a link: {g.docs}</span>
            ) : (
              <span className="ne-muted">This rule names no docs page.</span>
            )}
          </p>
        </div>
        <div>
          <span className="ne-label">What a fix would change</span>
          <p style={{ margin: '2px 0 0' }}>{g.fix}</p>
          <p className="ne-faint" style={{ margin: '4px 0 0', fontSize: 12 }}>
            <Icon name="lock" size={12} /> Read-only portal: it shows the change; it never applies one.
          </p>
        </div>
      </div>
    </section>
  );
}

const MUTE_OPTIONS = [
  { minutes: 60, label: '1 hour' },
  { minutes: 240, label: '4 hours' },
  { minutes: 1440, label: '1 day' },
  { minutes: 10080, label: '7 days' },
];

function Notes({ d, canAnnotate, onChanged }: { d: AlertDetailResponse; canAnnotate: boolean; onChanged: () => void }) {
  const call = useBackend();
  const [text, setText] = useState('');
  const [minutes, setMinutes] = useState(240);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const ack = d.notes.find(n => n.kind === 'ack');
  const mute = d.alert.muted;
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await fn();
      setText('');
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const post = (body: object) => call<AlertNote>(`/alerts/${d.alert.id}/notes`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const remove = (kind: 'ack' | 'mute') => call<void>(`/alerts/${d.alert.id}/notes/${kind}`, { method: 'DELETE' });
  return (
    <section className="ne-fix-section">
      <h3>
        <Icon name="doc" size={14} /> Acknowledge and mute
      </h3>
      <p className="ne-faint" style={{ margin: '0 0 6px', fontSize: 12 }}>Local notes, stored in the portal with your user ref. Nothing is sent anywhere or changed in the cloud.</p>
      <ul className="ne-ov-mini" style={{ marginBottom: 8 }}>
        <li>{ack ? `Acknowledged by ${ack.userRef} ${fmtTime(ack.createdAt)}${ack.note ? `: “${ack.note}”` : ''}` : 'Not acknowledged.'}</li>
        <li>{mute ? `Muted by ${mute.userRef} until ${fmtTime(mute.until)}${mute.note ? `: “${mute.note}”` : ''}` : 'Not muted.'}</li>
      </ul>
      {canAnnotate ? (
        <div className="ne-stack" style={{ gap: 8 }}>
          <Field label="Note (optional)" htmlFor="alert-note">
            <input id="alert-note" className="ne-input" value={text} maxLength={500} onChange={e => setText(e.target.value)} />
          </Field>
          <div className="ne-row" style={{ gap: 8, flexWrap: 'wrap' }}>
            {ack ? (
              <button type="button" className="ne-btn ne-btn-sm" disabled={busy} onClick={() => run(() => remove('ack'))}>
                Remove acknowledgement
              </button>
            ) : (
              <button type="button" className="ne-btn ne-btn-sm ne-btn-primary" disabled={busy} onClick={() => run(() => post({ kind: 'ack', note: text || undefined }))}>
                Acknowledge
              </button>
            )}
            {mute ? (
              <button type="button" className="ne-btn ne-btn-sm" disabled={busy} onClick={() => run(() => remove('mute'))}>
                Unmute
              </button>
            ) : (
              <>
                <select className="ne-select" aria-label="Mute for" value={minutes} onChange={e => setMinutes(Number(e.target.value))}>
                  {MUTE_OPTIONS.map(o => (
                    <option key={o.minutes} value={o.minutes}>
                      {o.label}
                    </option>
                  ))}
                </select>
                <button type="button" className="ne-btn ne-btn-sm" disabled={busy} onClick={() => run(() => post({ kind: 'mute', minutes, note: text || undefined }))}>
                  Mute
                </button>
              </>
            )}
          </div>
          {error ? <p className="ne-field-error" role="alert">{error}</p> : null}
        </div>
      ) : (
        <p className="ne-muted" style={{ margin: 0 }}>You can read alerts; acknowledging and muting needs nebius.alerts.annotate.</p>
      )}
    </section>
  );
}

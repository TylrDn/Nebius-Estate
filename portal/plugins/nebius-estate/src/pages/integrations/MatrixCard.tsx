import type { CapabilityRow, CapabilityStatus, ConnectorStatus } from '@internal/nebius-domain';
import { Badge, Card, DataTable, StatusPill } from '../../ui';
import { Fragment } from 'react';
import { countStates, MatrixView, matrixView } from './model';

/** A path or API name that breaks after its separators (/ , . ?), never between letters (#57). */
export function Breakable({ text }: { text: string }) {
  const parts = text.split(/(?<=[/,.?=])/);
  return (
    <>
      {parts.map((p, i) => (
        <Fragment key={i}>
          {p}
          {i < parts.length - 1 ? <wbr /> : null}
        </Fragment>
      ))}
    </>
  );
}

const TESTED_TONE = { 'live-verified': 'ok', 'contract-tested': 'info' } as const;

/** What this deployment saw for a documented row at the last sync, from the data alone. */
function LiveState({ v }: { v: MatrixView }) {
  if (v.capabilities.length) {
    return (
      <div className="ne-row" style={{ gap: 4 }}>
        {countStates(v.capabilities).map(([state, n]) => (
          <StatusPill key={state} state={state} label={`${n} ${state.replace(/-/g, ' ')}`} />
        ))}
      </div>
    );
  }
  if (v.connectors.length) {
    return (
      <div className="ne-row" style={{ gap: 4 }}>
        {v.connectors.map(s => (
          <span key={s.id} className="ne-row" style={{ gap: 4 }}>
            <span className="ne-muted" style={{ fontSize: '0.75rem' }}>
              {s.title}
            </span>
            <StatusPill state={s.state} />
          </span>
        ))}
      </div>
    );
  }
  if (v.idle) return <span className="ne-muted" style={{ fontSize: '0.75rem' }}>{v.idle}</span>;
  return <Badge tone="neutral">no call at the last sync</Badge>;
}

/** The documented test level, superseded by a live verification date from the capabilities when there is one. */
function Tested({ v }: { v: MatrixView }) {
  if (v.verified) return <Badge tone="ok" wrap title="Seen to answer on a live account (project-level viewer)">{`live-verified ${v.verified}`}</Badge>;
  const t = v.row.tested;
  if (t === 'live-verified' || t === 'contract-tested') return <Badge tone={TESTED_TONE[t]}>{t}</Badge>;
  return <span className="ne-faint">not tested</span>;
}

/**
 * The capability matrix as documentation (what each service documents, the permissions it needs, the
 * fallback), joined with the live state so no row claims more than the last sync showed.
 */
export function MatrixCard({ rows, capabilities, statuses }: { rows: CapabilityRow[]; capabilities: CapabilityStatus[]; statuses: ConnectorStatus[] }) {
  return (
    // No card title: the fold above it names the section (#57).
    <Card
      flush
      footer="Documentation checked against docs.nebius.com, github.com/nebius/api and the public api.nebius.cloud OpenAPI document. “This deployment” is the state of the matching calls (or connectors) at the last sync; live-verified = the call answered on a real account with a project-level viewer permit; contract-tested = unit tests against the documented shapes with mocked HTTP."
    >
      <DataTable<MatrixView>
        caption="Capability matrix"
        rows={matrixView(rows, capabilities, statuses)}
        rowKey={v => v.row.service}
        columns={[
          // Shares of the card: with auto widths an unbroken repository path in Fallback set the table to 1,232 px in a
          // 1,150 px card and squeezed the API paths to one character per line (#57).
          { key: 's', header: 'Service', width: '13%', render: v => <strong style={{ fontWeight: 600 }}>{v.row.service}</strong> },
          {
            key: 'a',
            header: 'Documented API',
            width: '22%',
            render: v => (
              <div className="ne-matrix-path">
                <div className="ne-mono" style={{ fontSize: 'var(--ne-fs-caption)' }}>
                  <Breakable text={v.row.documentedApi} />
                </div>
                {v.row.restPath ? (
                  <div className="ne-faint ne-mono" style={{ fontSize: 'var(--ne-fs-caption)' }}>
                    <Breakable text={v.row.restPath} />
                  </div>
                ) : null}
              </div>
            ),
          },
          { key: 'l', header: 'This deployment (last sync)', width: '13%', render: v => <LiveState v={v} /> },
          { key: 't', header: 'Tested', width: '11%', render: v => <Tested v={v} /> },
          { key: 'p', header: 'Permissions', width: '12%', render: v => <span className="ne-muted ne-u1-wrap" style={{ fontSize: '0.75rem' }}>{v.row.permissions}</span> },
          {
            key: 'f',
            header: 'Fallback · limits',
            render: v => (
              <div className="ne-matrix-path" style={{ fontSize: '0.75rem' }}>
                <div>{v.row.fallback}</div>
                {v.row.limitations ? <div className="ne-faint">{v.row.limitations}</div> : null}
              </div>
            ),
          },
        ]}
      />
    </Card>
  );
}

import { Link } from 'react-router-dom';
import type { SectionCoverage } from '@internal/nebius-domain';
import { Badge, DataTable, Tone } from '../../ui';

const STATE: Record<SectionCoverage['state'], { tone: Tone; label: string }> = {
  read: { tone: 'ok', label: 'read' },
  failing: { tone: 'warn', label: 'called, not answering' },
  'not-read': { tone: 'neutral', label: 'not read' },
  reference: { tone: 'neutral', label: 'docs only' },
  'not-classified': { tone: 'warn', label: 'not classified' },
};

/** The section's link on the Nebius docs page. */
export const sectionHref = (section: string) => `/nebius-docs?section=${encodeURIComponent(section)}`;

/**
 * Coverage stated against the docs catalog (W1-P26): every service section, read through which calls, and for each one
 * not read, why and what that leaves out. `reference`: show the documentation-only sections too.
 */
export function DocsCoverageTable({ rows, reference = false }: { rows: SectionCoverage[]; reference?: boolean }) {
  const shown = rows
    .filter(r => reference || r.state !== 'reference')
    .sort((a, b) => Number(a.state === 'read') - Number(b.state === 'read') || a.section.localeCompare(b.section));
  return (
    <DataTable<SectionCoverage>
      caption="Coverage against the Nebius docs"
      rows={shown}
      rowKey={r => r.section}
      columns={[
        { key: 's', header: 'Docs section', width: '18%', render: r => <Link to={sectionHref(r.section)}>{r.section === '/' ? 'home' : r.section}</Link>, sortValue: r => r.section },
        { key: 'st', header: 'Portal', width: '16%', render: r => <Badge tone={STATE[r.state].tone} wrap>{STATE[r.state].label}</Badge>, sortValue: r => r.state },
        {
          key: 'c',
          header: 'Read through',
          width: '22%',
          render: r =>
            r.calls.total ? (
              <span className="ne-u1-wrap" title={r.calls.ids.join(', ')}>
                {`${r.calls.ok} of ${r.calls.total} call${r.calls.total === 1 ? '' : 's'} answered`}
                {r.how ? <span className="ne-faint"> · {r.how}</span> : null}
              </span>
            ) : (
              <span className="ne-faint">no call</span>
            ),
        },
        {
          key: 'r',
          header: 'Why · what it leaves out',
          render: r => (
            <span className="ne-u1-wrap">
              {r.reason ?? <span className="ne-faint">—</span>}
              {r.impact ? <span className="ne-muted"> {r.impact}</span> : null}
            </span>
          ),
        },
      ]}
    />
  );
}

import { Link } from 'react-router-dom';
import { isUnattributed, setupChecklist, setupProgress } from '@internal/nebius-domain';
import type { BudgetsResponse, ConnectorStatus, RateBookSummary, ResourceListResponse, SetupState, Unread } from '@internal/nebius-domain';
import { ApiError, Badge, Card, Loadable, Tone, useGet } from '../../ui';

const STATE: Record<SetupState, { tone: Tone; label: string }> = {
  done: { tone: 'ok', label: 'done' },
  'in-progress': { tone: 'warn', label: 'in progress' },
  'to-do': { tone: 'danger', label: 'to do' },
  'not-applicable': { tone: 'neutral', label: 'not applicable' },
  checking: { tone: 'neutral', label: 'checking' },
  unavailable: { tone: 'warn', label: 'unavailable' },
};

/** A read's value, or why there is none: still loading, refused for the role (403), or another failure (W1-P25). */
export function readOf<T, V>(l: Pick<Loadable<T>, 'data' | 'error'>, value: (data: T) => V): V | Unread {
  if (l.error) return l.error instanceof ApiError && l.error.permissionDenied ? { unread: 'forbidden' } : { unread: 'error', message: l.error.message };
  return l.data ? value(l.data) : { unread: 'loading' };
}

/**
 * The day-one setup checklist (W1-P25): each step to do, in progress or done from what the portal reads, with the page
 * where the next step happens. A list the caller is refused (rate books, budgets) is said as not readable, never
 * counted as done; one still loading is "checking" and one that failed is "unavailable", neither counted.
 */
export function SetupChecklist({ statuses }: { statuses: ConnectorStatus[] }) {
  const books = useGet<{ items: RateBookSummary[] }>('/ratebooks');
  const budgets = useGet<BudgetsResponse>('/budgets');
  const resources = useGet<ResourceListResponse>('/resources');
  const items = setupChecklist({
    statuses,
    rateBooks: readOf(books, d => d.items.filter(b => !b.archived).length),
    budgets: readOf(budgets, d => ({ budgets: d.budgets.length + d.configBudgets.length, credits: d.credits.length })),
    resources: readOf(resources, d => ({ total: d.items.length, unattributed: d.items.filter(isUnattributed).length })),
  });
  const progress = setupProgress(items);
  return (
    <section id="setup" aria-label="Day-one setup" className="ne-section">
      <Card title={progress.title} icon="check" flush>
        <ul className="ne-setup-list" aria-busy={progress.checking ? 'true' : undefined}>
          {items.map(i => (
            <li key={i.id} data-state={i.state}>
              <Badge tone={STATE[i.state].tone}>{STATE[i.state].label}</Badge>
              <span className="ne-setup-text">
                <strong>{i.label}</strong> <span className="ne-muted">{i.detail}</span>
              </span>
              {i.state === 'done' || i.state === 'not-applicable' || i.state === 'checking' ? null : <Link to={i.to} className="ne-setup-next">{`${i.action} →`}</Link>}
            </li>
          ))}
        </ul>
      </Card>
    </section>
  );
}

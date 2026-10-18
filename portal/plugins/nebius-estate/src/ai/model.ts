import type { AiCheckState, AiServicesResponse, HfModelCheck } from '@internal/nebius-domain';
import type { Tone } from '../ui';

export function checkBadge(state: AiCheckState, stale = false): { tone: Tone; label: string } {
  switch (state) {
    case 'ok':
      return { tone: 'ok', label: 'connected' };
    case 'schema-drift':
      return { tone: 'warn', label: 'answered with an unexpected shape' };
    case 'invalid-credential':
      return { tone: 'danger', label: 'refused' };
    case 'unreachable':
      return { tone: 'warn', label: stale ? 'unreachable · showing last good data' : 'unreachable' };
    case 'not-configured':
      return { tone: 'neutral', label: 'not configured' };
    default:
      return { tone: 'neutral', label: 'first check pending' };
  }
}

export function accessBadge(m: Pick<HfModelCheck, 'gated' | 'accessible'>): { tone: Tone; label: string } {
  if (m.accessible === null) return { tone: 'neutral', label: m.gated === null ? 'not checked' : m.gated ? 'gated · access unknown' : 'open · access unknown' };
  if (m.accessible) return { tone: 'ok', label: m.gated ? 'gated · access granted' : 'open · readable' };
  return { tone: 'danger', label: m.gated ? 'gated · no access' : 'not readable' };
}

/** The API echoes the request time as `created` for some models: a created time within a minute of the fetch (or after it) is not a real date. */
const ECHO_MS = 60_000;

export function createdText(created: string | undefined, fetchedAt: string | undefined): string {
  if (!created) return 'not reported';
  const c = Date.parse(created);
  const f = fetchedAt ? Date.parse(fetchedAt) : NaN;
  if (Number.isFinite(c) && Number.isFinite(f) && c > f - ECHO_MS) return 'not reported';
  return created.slice(0, 10);
}

/** The Created column's sort key: a time that is the request echoed back sorts as unknown (''), like a missing one (G3.16). */
export function createdSortValue(created: string | undefined, fetchedAt: string | undefined): string {
  return createdText(created, fetchedAt) === 'not reported' ? '' : created ?? '';
}

/**
 * An empty Serverless list says what is known (F1.36): "None in the listed projects" only when every list answered;
 * unreachable lists are unknown, and partly read lists say what may be missing.
 */
export function serverlessEmpty(s: Pick<AiServicesResponse['serverless'], 'listed' | 'note'>): { title: string; text: string } {
  if (s.listed === 'all') return { title: 'No Serverless endpoints or jobs', text: 'None in the listed projects (Nebius Serverless AI lists).' };
  if (s.listed === 'partial') return { title: 'None found where the lists answered', text: `Not every list or project answered${s.note ? ` (${s.note})` : ''}, so some may be missing.` };
  return { title: 'Serverless endpoints and jobs: unknown', text: `Not read: ${s.note ?? 'the lists have not answered yet'}. They show here once the lists answer (Integrations).` };
}

/** The registries and MLflow table's empty state, said as the Serverless one is (F1.36): "none" only when both lists answered. */
export function mlServicesEmpty(s: Pick<AiServicesResponse['mlServices'], 'listed' | 'note'>): { title: string; text: string } {
  if (s.listed === 'all') return { title: 'No container registry or MLflow cluster', text: 'None in the listed projects (Nebius registry and Managed MLflow lists). Recipe R12 (ml-services) creates both.' };
  if (s.listed === 'partial') return { title: 'None found where the lists answered', text: `Not every list or project answered${s.note ? ` (${s.note})` : ''}, so some may be missing.` };
  return { title: 'Registries and MLflow: unknown', text: `Not read: ${s.note ?? 'the lists have not answered yet'}. They show here once the lists answer (Integrations).` };
}

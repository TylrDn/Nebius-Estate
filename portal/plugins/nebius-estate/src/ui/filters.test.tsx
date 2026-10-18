import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { ignoredFilterValues, useGlobalFilter } from './filters';

const options = { projects: [{ id: 'project-e00a', name: 'sandbox' }], regions: ['eu-north1'], stages: ['sandbox'] };

describe('global filter', () => {
  it('names values from the URL that cannot apply, instead of dropping them silently', () => {
    expect(ignoredFilterValues(new URLSearchParams('region=xx-bogus1&stage=sandbox'), options)).toEqual([{ key: 'region', value: 'xx-bogus1', reason: 'no project in your scope is in this region' }]);
    expect(ignoredFilterValues(new URLSearchParams('project=not-a-project!'), options)).toEqual([{ key: 'project', value: 'not-a-project!', reason: 'not a valid project id' }]);
    expect(ignoredFilterValues(new URLSearchParams('stage=prod&project=project-e00b'), options).map(x => x.key)).toEqual(['project', 'stage']);
    expect(ignoredFilterValues(new URLSearchParams('region=eu-north1'), options)).toEqual([]);
  });

  it('does not judge a value against a scope the backend has not read yet: a valid project link survives the first sync (#32)', () => {
    const empty = { projects: [], regions: [], stages: [], pending: true as const };
    expect(ignoredFilterValues(new URLSearchParams('project=project-e00b&region=eu-north1&stage=prod'), empty)).toEqual([]);
    // An invalid id is still refused: no sync makes it valid.
    expect(ignoredFilterValues(new URLSearchParams('project=not-a-project!'), empty)).toEqual([{ key: 'project', value: 'not-a-project!', reason: 'not a valid project id' }]);
  });

  it('pushes a filter change, so Back undoes it', () => {
    function Probe() {
      const [f, set] = useGlobalFilter();
      const loc = useLocation();
      const nav = useNavigate();
      return (
        <div>
          <span data-testid="search">{loc.search}</span>
          <span data-testid="region">{f.region ?? 'all'}</span>
          <button type="button" onClick={() => set({ region: 'eu-north1' })}>set</button>
          <button type="button" onClick={() => nav(-1)}>back</button>
        </div>
      );
    }
    render(
      <MemoryRouter initialEntries={['/capacity']}>
        <Probe />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByText('set'));
    expect(screen.getByTestId('region')).toHaveTextContent('eu-north1');
    fireEvent.click(screen.getByText('back'));
    expect(screen.getByTestId('region')).toHaveTextContent('all');
  });
});

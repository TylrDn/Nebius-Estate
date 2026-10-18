import { fireEvent, render, screen } from '@testing-library/react';
import type { SolutionsResponse } from '@internal/nebius-domain';
import { SOLUTION_PRICE_FOOTER, SolutionsTab } from './SolutionsTab';

const data: SolutionsResponse = {
  items: [
    {
      id: 'S1',
      dir: 'solutions/S1-x',
      readme: 'solutions/S1-x/README.md',
      scenario: 'Inference',
      recipes: [],
      workedExample: 'w',
      headline: 'h',
      status: 's',
      readmeAvailable: true,
      footprints: [{ path: 'solutions/S1-x/footprint.json', capacityTypes: ['on-demand'], footprint: { nodeGroups: [], filesystemGib: 0, extraSsdGib: 0, ioM3Gib: 0, objectStorageGib: 0, publicIps: 0 }, notes: [] }],
      proof: [],
      proofDrift: [],
    },
  ],
};

describe('Solutions tab', () => {
  it('"Price this footprint" is a disclosure button (aria-expanded), not a toggle (aria-pressed)', () => {
    render(<SolutionsTab data={data} openDoc={() => undefined} setPrice={() => undefined} />);
    const b = screen.getByRole('button', { name: 'Price this footprint: S1' });
    expect(b).toHaveAttribute('aria-expanded', 'false');
    expect(b).not.toHaveAttribute('aria-pressed');
    expect(b).not.toHaveAttribute('aria-controls'); // nothing to point at while closed
  });

  it('G5.13: the price card footer names price.py plainly and carries no date of its own', () => {
    expect(SOLUTION_PRICE_FOOTER).toMatch(/is what recipes\/finance\/price\.py prices/);
    expect(SOLUTION_PRICE_FOOTER).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});

describe('W1-P11, W1-P12, W1-P13: proof from evidence on a solution card', () => {
  const live = { recipe: 'R12', level: 'Live run' as const, lastLive: '2026-10-12', path: 'docs/evidence/ml.md', title: 'ml' };
  const s9: SolutionsResponse = {
    items: [
      {
        ...data.items[0],
        id: 'S9',
        status: 'designed; R12 not run',
        proof: [live, { recipe: 'R5', level: 'Mocked only' }, { recipe: 'R3', level: 'Live read / plan', lastLive: '2026-10-11', path: 'docs/evidence/plans.md', title: 'plans' }],
        proofDrift: [{ recipe: 'R12', says: 'not run', claim: { path: 'solutions/README.md', where: 'solutions/README.md, S9 Status', text: 'designed; R12 not run' }, proof: live }],
      },
    ],
  };

  it('derives the status line and one chip per recipe, with its level and last live date or "Not measured"', () => {
    const open: string[] = [];
    render(<SolutionsTab data={s9} openDoc={p => open.push(p)} setPrice={() => undefined} />);
    expect(screen.getByText('1 of 3 recipes run live · 1 planned or read only')).toBeInTheDocument();
    const chips = screen.getAllByRole('listitem').map(li => li.textContent);
    expect(chips).toEqual(expect.arrayContaining(['R12 Live run last live 2026-10-12', 'R5 Mocked only Not measured', 'R3 Live read / plan last live 2026-10-11']));
    fireEvent.click(screen.getByRole('button', { name: 'last live 2026-10-12, read docs/evidence/ml.md' }));
    expect(open).toEqual(['docs/evidence/ml.md']);
    // The hand-written status stays, labelled as the README's and as the whole solution's, so "not deployed" does not
    // read against "N of M recipes run live" (Wave 1 verification).
    expect(screen.getByText('Recipe proof (evidence)')).toBeInTheDocument();
    expect(screen.getByText('Solution status (README)')).toBeInTheDocument();
  });

  it('says where a README proof row disagrees with the evidence index', () => {
    render(<SolutionsTab data={s9} openDoc={() => undefined} setPrice={() => undefined} />);
    expect(screen.getByText('README proof rows disagree with the evidence index')).toBeInTheDocument();
    expect(screen.getByText(/solutions\/README\.md, S9 Status says R12 not run; the evidence index has Live run 2026-10-12 \(ml\.md\)/)).toBeInTheDocument();
  });

  it('shows no banner when the rows agree', () => {
    render(<SolutionsTab data={data} openDoc={() => undefined} setPrice={() => undefined} />);
    expect(screen.queryByText('README proof rows disagree with the evidence index')).toBeNull();
  });
});

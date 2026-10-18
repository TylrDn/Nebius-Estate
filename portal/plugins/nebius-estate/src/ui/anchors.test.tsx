import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useScrollToHash } from './anchors';
import { Reference, SectionLinks } from '.';

function Page() {
  useScrollToHash(true);
  return (
    <>
      <SectionLinks sections={[{ id: 'quotas', label: 'Quotas' }, { id: 'calculator', label: 'Calculator' }]} />
      <div id="quotas">Quotas</div>
      <Reference id="calculator" title="Footprint calculator" hint="what a plan needs, priced">
        <label>
          expected GPU nodes <input />
        </label>
      </Reference>
    </>
  );
}

describe('reference sections (F1.13)', () => {
  it('start folded, with a title and a one-line hint', () => {
    render(
      <MemoryRouter>
        <Page />
      </MemoryRouter>,
    );
    const section = document.getElementById('calculator') as HTMLDetailsElement;
    expect(section.tagName).toBe('DETAILS');
    expect(section.open).toBe(false);
    expect(screen.getByRole('heading', { name: 'Footprint calculator' })).toBeInTheDocument();
    expect(section).toHaveTextContent('what a plan needs, priced');
  });

  it('open when a link in the URL or "On this page" names them', () => {
    render(
      <MemoryRouter initialEntries={['/capacity#calculator']}>
        <Page />
      </MemoryRouter>,
    );
    const section = document.getElementById('calculator') as HTMLDetailsElement;
    expect(section.open).toBe(true);
    section.open = false;
    fireEvent.click(screen.getByRole('link', { name: 'Calculator' }));
    expect(section.open).toBe(true);
  });
});

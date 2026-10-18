import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { Link, MemoryRouter, Route, Routes, resolvePath, useLocation, useNavigate } from 'react-router-dom';

// Inputs from remix-run/react-router#15176. The path utility normalizes them;
// navigation rejects them since #15446 (7.18.3) as potential external targets.
const mixedSeparators = ['//foo', '\\\\foo', '/\\foo', '\\/foo'];

function NavigationProbe({ destination }: { destination: string }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [error, setError] = useState<string>();
  const navigateToDestination = () => {
    try {
      navigate(destination);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  return (
    <>
      <button onClick={navigateToDestination}>Navigate</button>
      {error && <div role="alert">{error}</div>}
      <Link to="/estate?project=example#resources">Estate</Link>
      <output aria-label="Current route">{location.pathname}{location.search}{location.hash}</output>
    </>
  );
}

describe('portal router security and navigation contract', () => {
  it.each(mixedSeparators)('normalizes mixed separators in resolvePath: %s', destination => {
    expect(resolvePath(destination)).toEqual({ pathname: '/foo', search: '', hash: '' });
  });

  it.each(mixedSeparators)('rejects external-looking navigation with mixed separators: %s', async destination => {
    render(
      <MemoryRouter initialEntries={['/capacity']}>
        <Routes>
          <Route path="/capacity/*" element={<NavigationProbe destination={destination} />} />
          <Route path="/foo" element={<h1>Local destination</h1>} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Navigate' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/^External navigation is not allowed$/);
    expect(screen.getByLabelText('Current route')).toHaveTextContent(/^\/capacity$/);
    expect(screen.queryByRole('heading', { name: 'Local destination' })).not.toBeInTheDocument();
  });

  it('allows normal internal navigation', async () => {
    render(
      <MemoryRouter initialEntries={['/capacity']}>
        <Routes>
          <Route path="/capacity/*" element={<NavigationProbe destination="/foo" />} />
          <Route path="/foo" element={<h1>Local destination</h1>} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Navigate' }));
    expect(await screen.findByRole('heading', { name: 'Local destination' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('preserves query strings and anchors when linking between Backstage splat pages', async () => {
    render(
      <MemoryRouter initialEntries={['/capacity/details?project=old#quotas']}>
        <Routes>
          <Route path="/capacity/*" element={<NavigationProbe destination="/estate" />} />
          <Route path="/estate/*" element={<NavigationProbe destination="/capacity" />} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('link', { name: 'Estate' }));
    expect(await screen.findByText('/estate?project=example#resources')).toBeInTheDocument();
  });
});

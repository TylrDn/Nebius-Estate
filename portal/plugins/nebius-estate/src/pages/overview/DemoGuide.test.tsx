import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { DemoGuide } from './DemoGuide';

describe('demo orientation', () => {
  it('stays absent for live or unknown metadata', () => {
    const { container } = render(<DemoGuide testData={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('carries the selected project, region and stage into the tour links', () => {
    render(<MemoryRouter><DemoGuide testData={{ endpoints: ['nebius.apiEndpoint'] }} filter={{ project: 'project-e00mock', region: 'eu-north1', stage: 'sandbox' }} /></MemoryRouter>);
    const link = screen.getByRole('link', { name: 'Estate Explorer', hidden: true });
    expect(link).toHaveAttribute('href', '/estate?project=project-e00mock&region=eu-north1&stage=sandbox');
  });

  it('offers a collapsed tour of existing pages with honest demonstration limits', () => {
    render(<MemoryRouter><DemoGuide testData={{ endpoints: ['nebius.apiEndpoint'] }} /></MemoryRouter>);
    const summary = screen.getByText('Explore this demo');
    const details = summary.closest('details');
    expect(details).not.toHaveAttribute('open');
    expect(details).toHaveTextContent('invented estate');
    expect(details).toHaveTextContent('does not apply');
    for (const [label, path] of [
      ['Estate Explorer', '/estate'],
      ['Costs', '/costs'],
      ['Provisioning', '/provisioning'],
      ['Evidence & Runbooks', '/evidence'],
      ['Nebius docs', '/nebius-docs'],
    ]) {
      expect(screen.getByRole('link', { name: label, hidden: true })).toHaveAttribute('href', path);
    }
  });
});

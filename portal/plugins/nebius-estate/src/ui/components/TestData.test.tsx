import { render, screen } from '@testing-library/react';
import { TestDataBannerView, TestDataMarkView } from './TestData';

describe('test data banner (F1.29)', () => {
  it('says "Test data — not your tenant" and names the settings that point at the test endpoint', () => {
    render(<TestDataBannerView testData={{ endpoints: ['nebius.apiEndpoint', 'billing.export.endpoint'] }} />);
    const banner = screen.getByRole('note', { name: 'Test data' });
    expect(banner).toHaveTextContent('Test data — not your tenant');
    expect(banner).toHaveTextContent('nebius.apiEndpoint, billing.export.endpoint');
    expect(banner).toHaveClass('ne-testdata');
  });

  it('marks the navigation too, so the mark stays on screen while the page scrolls', () => {
    render(<TestDataMarkView testData={{ endpoints: ['nebius.apiEndpoint'] }} />);
    expect(screen.getByText('Test data')).toHaveAttribute('title', expect.stringMatching(/not your tenant/));
  });

  it('shows nothing in a live run (no testData in /meta)', () => {
    const { container } = render(
      <>
        <TestDataBannerView testData={undefined} />
        <TestDataMarkView testData={undefined} />
      </>,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

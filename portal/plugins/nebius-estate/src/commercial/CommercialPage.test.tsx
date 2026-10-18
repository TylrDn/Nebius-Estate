import { fireEvent, render, screen } from '@testing-library/react';
import { NewScenarioPanel } from './CommercialPage';

describe('commercial: New scenario panel (walkthrough 3)', () => {
  it('stays collapsed, without Cancel, while no rate book exists', () => {
    render(<NewScenarioPanel books={[]} canWrite onCreated={() => undefined} onCancel={() => undefined} />);
    expect(screen.getByText(/Import or build a rate book first/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('says the rate book comes first and offers a button to the Rate books tab (#49)', () => {
    const open = jest.fn();
    render(<NewScenarioPanel books={[]} canWrite onCreated={() => undefined} onOpenRateBooks={open} />);
    expect(screen.getByText('A scenario is priced from a rate book, and none is imported yet.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open Rate books' }));
    expect(open).toHaveBeenCalled();
  });
});

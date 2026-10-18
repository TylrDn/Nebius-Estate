import { render, screen } from '@testing-library/react';
import { SignInError, signInFailure } from './SignInError';

describe('sign-in failure', () => {
  it('tells a backend that does not answer apart from a refused sign-in', () => {
    expect(signInFailure(new TypeError('Failed to fetch'))).toBe('backend-unreachable');
    expect(signInFailure(new TypeError('NetworkError when attempting to fetch resource.'))).toBe('backend-unreachable');
    expect(signInFailure(Object.assign(new Error('Request failed with 503 Service Unavailable'), { name: 'ResponseError' }))).toBe('backend-unreachable');
    expect(signInFailure(Object.assign(new Error('Request failed with 401 Unauthorized'), { name: 'ResponseError' }))).toBe('not-signed-in');
  });

  it('says "backend unreachable", not "You do not appear to be signed in", when the backend is down', () => {
    render(<SignInError error={new TypeError('Failed to fetch')} />);
    expect(screen.getByRole('heading', { name: 'Portal backend unreachable' })).toBeInTheDocument();
    expect(screen.queryByText(/do not appear to be signed in/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});

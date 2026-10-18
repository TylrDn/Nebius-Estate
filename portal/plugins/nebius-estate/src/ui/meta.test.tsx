import { act, renderHook, waitFor } from '@testing-library/react';

// Two separate stable objects, as useApi returns: the discovery and fetch APIs.
const discovery = { getBaseUrl: async () => 'http://backend/api/nebius-estate' };
const fetchApi = { fetch: jest.fn() };
jest.mock('@backstage/frontend-plugin-api', () => ({
  ...jest.requireActual('@backstage/frontend-plugin-api'),
  useApi: (ref: { id: string }) => (ref.id.includes('discovery') ? discovery : fetchApi),
}));

// eslint-disable-next-line import/first
import { META_RETRY_MS, useMeta } from './api';

describe('session meta (/meta)', () => {
  afterEach(() => jest.useRealTimers());

  it('a failed /meta is asked again, so a page whose first call failed still says "Test data" once the backend answers', async () => {
    jest.useFakeTimers();
    const meta = { user: 'user:default/e2e', scope: ['*'], permissions: {}, testData: { endpoints: ['nebius.apiEndpoint'] } };
    fetchApi.fetch
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'busy' } }), { status: 503 }))
      .mockResolvedValue(new Response(JSON.stringify(meta), { status: 200 }));
    const { result } = renderHook(() => useMeta());
    await waitFor(() => expect(result.current.error?.message).toBe('busy'));
    expect(result.current.data).toBeUndefined();
    await act(async () => {
      jest.advanceTimersByTime(META_RETRY_MS);
    });
    await waitFor(() => expect(result.current.data?.testData?.endpoints).toEqual(['nebius.apiEndpoint']));
    expect(result.current.error).toBeUndefined();
    expect(fetchApi.fetch).toHaveBeenCalledTimes(2);
  });
});

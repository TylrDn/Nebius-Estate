import { HttpClient } from '../lib/http';
import { LogQueryFailedError, LogsClient } from './LogsClient';

describe('LogsClient', () => {
  const base = 'https://read.logging.example.test';
  const client = (fetch: jest.Mock) =>
    new LogsClient(new HttpClient({ allowedOrigins: [base], timeoutMs: 1000, fetch, sleep: async () => undefined, baseDelayMs: 1 }), base);

  it('does not retry a 500 from query_range and says what likely failed, without the upstream URL (G3.5)', async () => {
    // Live 2026-10-12: `{__bucket__="sp_serial"} | json` answers 500 every time (sp_serial lines are plain text).
    const fetch = jest.fn(async () => new Response('internal error', { status: 500 }));
    const err = await client(fetch).queryRange('project-e00mocksandbox', 'sp_serial', '{__bucket__="sp_serial"} | json', 0, 60_000, 10).catch(e => e);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(err).toBeInstanceOf(LogQueryFailedError);
    expect(err.message).toBe('Nebius Logs could not run this query (HTTP 500). Parser stages such as | json fail on buckets whose lines are not JSON (sp_serial is plain text); use a line filter (|= "text") instead.');
    expect(err.message).not.toMatch(/https?:|project-/);
  });

  it('still retries a 503 from query_range', async () => {
    const fetch = jest.fn()
      .mockResolvedValueOnce(new Response('busy', { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'success', data: { resultType: 'streams', result: [] } }), { status: 200 }));
    expect(await client(fetch).queryRange('project-e00mocksandbox', 'sp_serial', '{__bucket__="sp_serial"}', 0, 60_000, 10)).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

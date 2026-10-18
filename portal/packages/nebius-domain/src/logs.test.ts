import { buildLogQuery, cleanLogLine, flattenStreams, LOG_PRESETS, validateLogQL } from './logs';

describe('LogQL for Nebius Logs', () => {
  it('builds a selector for a bucket, a resource and a text', () => {
    expect(buildLogQuery({ bucket: 'sp_serial' })).toBe('{__bucket__="sp_serial"}');
    expect(buildLogQuery({ bucket: 'sp_serial', resourceId: 'computeinstance-1', contains: 'say "hi"' })).toBe('{__bucket__="sp_serial", sp_resource_id="computeinstance-1"} |= "say \\"hi\\""');
  });

  it('accepts every preset and a query it built', () => {
    for (const p of LOG_PRESETS) expect(validateLogQL(p.query)).toEqual({ ok: true, errors: [], bucket: p.bucket });
    expect(validateLogQL(buildLogQuery({ bucket: 'default', contains: 'x' })).ok).toBe(true);
  });

  it('explains what is wrong with a query instead of sending it', () => {
    const errs = (q: string) => validateLogQL(q).errors.join(' | ');
    expect(errs('')).toMatch(/Enter a query/);
    expect(errs('{level="error"}')).toMatch(/must name a bucket/);
    expect(errs('{__bucket__="sp_serial"} |= "error')).toMatch(/not closed/);
    expect(errs('{__bucket__="sp_serial"')).toMatch(/not balanced/);
    expect(errs('{__bucket__="nope"}')).toMatch(/Unknown bucket "nope"/);
    expect(errs('sum(rate({__bucket__="sp_serial"}[5m]))')).toMatch(/metric query/);
    expect(errs('bytes_rate({__bucket__="sp_serial"}[5m])')).toMatch(/not supported/);
    expect(errs('{__bucket__=~"sp_.*"}')).toMatch(/must name a bucket/);
  });

  it('cleans terminal colour codes from serial-console lines', () => {
    expect(cleanLogLine('[\u001b[0;1;31mFAILED\u001b[0m] Failed to start x\r\r')).toBe('[FAILED] Failed to start x');
  });

  it('flattens streams newest first, bounded', () => {
    const lines = flattenStreams(
      [
        { stream: { a: '1' }, values: [['1791705205546061000', 'old'], ['1791705207979727000', 'mid']] },
        { stream: { a: '2' }, values: [['1791705208203695000', 'new']] },
      ],
      2,
    );
    expect(lines.map(l => l.line)).toEqual(['new', 'mid']);
    expect(lines[0]).toMatchObject({ time: '2026-10-11T07:53:28.203Z', labels: { a: '2' } });
  });
});

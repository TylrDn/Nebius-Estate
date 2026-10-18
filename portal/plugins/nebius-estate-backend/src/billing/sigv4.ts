import { createHash, createHmac } from 'crypto';

/**
 * AWS Signature Version 4 for S3-compatible reads (Nebius Object Storage), with
 * node:crypto only. Signs exactly the headers it is given plus `host` and
 * `x-amz-date`; S3 reads use `x-amz-content-sha256: UNSIGNED-PAYLOAD`.
 * Reference: docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html
 */

export interface SigV4Credentials {
  accessKeyId: string;
  secretAccessKey: string;
}

export const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';
export const EMPTY_SHA256 = createHash('sha256').update('').digest('hex');

/** RFC 3986 encoding as SigV4 requires (encodeURIComponent leaves !'()* alone). */
export const rfc3986 = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

const hmac = (key: Buffer | string, data: string) => createHmac('sha256', key).update(data, 'utf8').digest();
const sha256 = (data: string) => createHash('sha256').update(data, 'utf8').digest('hex');

export function amzDate(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

export function signV4(opts: {
  method: string;
  url: string;
  /** Headers to sign besides host and x-amz-date (lower-case names). */
  headers?: Record<string, string>;
  payloadHash: string;
  credentials: SigV4Credentials;
  region: string;
  service: string;
  now: Date;
}): Record<string, string> {
  const u = new URL(opts.url);
  const date = amzDate(opts.now);
  const day = date.slice(0, 8);
  const headers: Record<string, string> = { host: u.host, 'x-amz-date': date };
  for (const [k, v] of Object.entries(opts.headers ?? {})) headers[k.toLowerCase()] = v;
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map(k => `${k}:${headers[k].trim().replace(/\s+/g, ' ')}\n`).join('');
  const signedHeaders = names.join(';');
  // S3 paths are encoded once, segment by segment.
  const canonicalUri = u.pathname.split('/').map(seg => rfc3986(decodeURIComponent(seg))).join('/') || '/';
  const canonicalQuery = [...u.searchParams.entries()]
    .map(([k, v]) => [rfc3986(k), rfc3986(v)])
    .sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : 1) : a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const canonicalRequest = [opts.method.toUpperCase(), canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, opts.payloadHash].join('\n');
  const scope = `${day}/${opts.region}/${opts.service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', date, scope, sha256(canonicalRequest)].join('\n');
  const kDate = hmac(`AWS4${opts.credentials.secretAccessKey}`, day);
  const kSigning = hmac(hmac(hmac(kDate, opts.region), opts.service), 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');
  return {
    ...Object.fromEntries(Object.entries(headers).filter(([k]) => k !== 'host')),
    Authorization: `AWS4-HMAC-SHA256 Credential=${opts.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

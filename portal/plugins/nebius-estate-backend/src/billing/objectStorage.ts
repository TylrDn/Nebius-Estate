import { HttpClient } from '../lib/http';
import { rfc3986, signV4, SigV4Credentials, UNSIGNED_PAYLOAD } from './sigv4';

/**
 * Read-only S3-compatible access to one Nebius Object Storage bucket
 * (path-style, https://storage.<region>.nebius.cloud/<bucket>), signed with
 * SigV4 (service s3, region = the bucket's region). Only ListObjectsV2 and
 * GetObject: the client refuses any other method.
 */

export interface StoredObject {
  key: string;
  etag: string;
  size: number;
  lastModified?: string;
}

const MAX_PAGES = 100;

const decodeXml = (s: string) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const tag = (xml: string, name: string) => {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? decodeXml(m[1]) : undefined;
};

/** Parses one ListObjectsV2 page (ListBucketResult). */
export function parseListPage(xml: string): { objects: StoredObject[]; next?: string } {
  const objects = [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map(m => ({
    key: tag(m[1], 'Key') ?? '',
    etag: (tag(m[1], 'ETag') ?? '').replace(/^"|"$/g, ''),
    size: Number(tag(m[1], 'Size') ?? NaN),
    lastModified: tag(m[1], 'LastModified'),
  }));
  const truncated = tag(xml, 'IsTruncated') === 'true';
  return { objects: objects.filter(o => o.key && Number.isFinite(o.size)), next: truncated ? tag(xml, 'NextContinuationToken') : undefined };
}

export class ObjectStorageReader {
  constructor(
    private readonly http: HttpClient,
    private readonly opts: { endpoint: string; region: string; bucket: string; credentials: SigV4Credentials; now?: () => Date },
  ) {}

  private sign(url: string) {
    return () =>
      signV4({ method: 'GET', url, headers: { 'x-amz-content-sha256': UNSIGNED_PAYLOAD }, payloadHash: UNSIGNED_PAYLOAD, credentials: this.opts.credentials, region: this.opts.region, service: 's3', now: this.opts.now?.() ?? new Date() });
  }

  /** Every object under `prefix`, following continuation tokens (bounded pages). */
  async list(prefix = ''): Promise<{ objects: StoredObject[]; truncated: boolean }> {
    const objects: StoredObject[] = [];
    let token: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      // The query is RFC 3986-encoded on the wire exactly as it is signed.
      const params: [string, string][] = [['list-type', '2'], ['max-keys', '1000']];
      if (prefix) params.push(['prefix', prefix]);
      if (token) params.push(['continuation-token', token]);
      const query = params.map(([k, v]) => `${rfc3986(k)}=${rfc3986(v)}`).join('&');
      const url = `${this.opts.endpoint}/${rfc3986(this.opts.bucket)}?${query}`;
      const xml = (await this.http.requestBytes(url, { maxBytes: 20 * 1024 * 1024, headersFor: this.sign(url) })).toString('utf8');
      const p = parseListPage(xml);
      objects.push(...p.objects);
      token = p.next;
      if (!token) return { objects, truncated: false };
    }
    return { objects, truncated: true };
  }

  async get(key: string, maxBytes: number): Promise<Buffer> {
    const url = `${this.opts.endpoint}/${rfc3986(this.opts.bucket)}/${key.split('/').map(rfc3986).join('/')}`;
    return this.http.requestBytes(url, { maxBytes, headersFor: this.sign(url) });
  }
}

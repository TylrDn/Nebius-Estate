import type { Meta } from '@internal/nebius-domain';
import { useMeta } from '../api';
import { Icon } from '../icons';

/**
 * A stub run must never pass for the tenant (F1.29): when the backend reads a test endpoint (`/meta` testData, set
 * only by a loopback test configuration), every page says so in its header and the navigation carries a mark that
 * stays on screen. A live run has no testData and renders nothing.
 */
type TestData = Meta['testData'];

const explain = (t: NonNullable<TestData>) =>
  `This portal reads a test endpoint (${t.endpoints.join(', ')}), not Nebius: every figure is invented test data, not your tenant.`;

export function TestDataBannerView({ testData }: { testData: TestData }) {
  if (!testData) return null;
  return (
    <div className="ne-testdata" role="note" aria-label="Test data" title={explain(testData)}>
      <Icon name="alert" size={14} />
      <span>
        <strong>Test data — not your tenant.</strong> <span className="ne-testdata-detail">{explain(testData).replace(/^This portal/, 'The backend')}</span>
      </span>
    </div>
  );
}

export function TestDataMarkView({ testData }: { testData: TestData }) {
  if (!testData) return null;
  return (
    <span className="ne-testdata-mark" title={explain(testData)}>
      Test data
    </span>
  );
}

export function TestDataBanner() {
  return <TestDataBannerView testData={useMeta().data?.testData} />;
}

export function TestDataMark() {
  return <TestDataMarkView testData={useMeta().data?.testData} />;
}

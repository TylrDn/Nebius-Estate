import { mapKubeObjects } from './kubernetes';

const empty = { nodes: [], namespaces: [], statefulsets: [], jobs: [], pvcs: [], events: [] };

describe('mapKubeObjects: pod health', () => {
  it('records restarts and the waiting reason of a crash-looping container', () => {
    const c = mapKubeObjects(
      'c',
      {
        ...empty,
        deployments: [{ metadata: { name: 'vllm', namespace: 'inference' }, spec: { replicas: 1, template: { spec: { containers: [{ name: 'vllm' }] } } }, status: { readyReplicas: 0 } }],
        replicasets: [{ metadata: { name: 'vllm-6486', namespace: 'inference', ownerReferences: [{ kind: 'Deployment', name: 'vllm' }] } }],
        pods: [
          {
            metadata: { name: 'vllm-6486-8bxm4', namespace: 'inference', ownerReferences: [{ kind: 'ReplicaSet', name: 'vllm-6486' }] },
            spec: { nodeName: 'n1' },
            status: {
              phase: 'Running',
              containerStatuses: [
                { name: 'vllm', ready: false, restartCount: 7, state: { waiting: { reason: 'CrashLoopBackOff' } } },
                { name: 'sidecar', ready: true, restartCount: 1, state: { running: {} } },
              ],
            },
          },
        ],
      },
      { observedAt: 'now' },
    );
    expect(c.workloads[0].pods[0]).toMatchObject({ phase: 'Running', restarts: 8, waiting: ['CrashLoopBackOff'] });
  });

  it('leaves both out for a pod without container statuses', () => {
    const c = mapKubeObjects(
      'c',
      {
        ...empty,
        deployments: [{ metadata: { name: 'a', namespace: 'n' }, spec: { replicas: 1 } }],
        replicasets: [{ metadata: { name: 'a-1', namespace: 'n', ownerReferences: [{ kind: 'Deployment', name: 'a' }] } }],
        pods: [{ metadata: { name: 'a-1-x', namespace: 'n', ownerReferences: [{ kind: 'ReplicaSet', name: 'a-1' }] }, status: { phase: 'Pending' } }],
      },
      { observedAt: 'now' },
    );
    expect(c.workloads[0].pods[0].restarts).toBeUndefined();
    expect(c.workloads[0].pods[0].waiting).toBeUndefined();
  });
});

// Followup 17: "100m+250m+100m" on the Workloads page; requests and limits are Kubernetes quantities and are summed.
describe('mapKubeObjects: requests and limits', () => {
  it('sums CPU, memory and GPU across containers in Kubernetes units', () => {
    const containers = [
      { name: 'a', resources: { requests: { cpu: '100m', memory: '128Mi', 'nvidia.com/gpu': '1' }, limits: { memory: '1Gi' } } },
      { name: 'b', resources: { requests: { cpu: '250m', memory: '1Gi' }, limits: { memory: '512Mi' } } },
      { name: 'c', resources: { requests: { cpu: '100m', memory: '256Mi' } } },
    ];
    const c = mapKubeObjects('c', { ...empty, replicasets: [], pods: [], deployments: [{ metadata: { name: 'app', namespace: 'n' }, spec: { replicas: 1, template: { spec: { containers } } } }] }, { observedAt: 'now' });
    expect(c.workloads[0].requests).toEqual({ cpu: '450m', memory: '1408Mi', 'nvidia.com/gpu': '1' });
    expect(c.workloads[0].limits).toEqual({ memory: '1536Mi' });
  });
});

// Followup 16: a Job whose pod failed showed amber "not ready (0/1)"; the Job's Failed condition and status.failed say it failed.
describe('mapKubeObjects: Job outcome', () => {
  const job = (status: Record<string, unknown>) =>
    mapKubeObjects('c', { ...empty, deployments: [], replicasets: [], pods: [], jobs: [{ metadata: { name: 'smoke', namespace: 'n' }, spec: { parallelism: 1, template: { spec: { containers: [] } } }, status }] }, { observedAt: 'now' }).workloads[0];

  it('reads the Failed condition with its reason, and the failed pod count', () => {
    const w = job({ failed: 2, conditions: [{ type: 'Failed', status: 'True', reason: 'BackoffLimitExceeded', message: 'Job has reached the specified backoff limit' }] });
    expect(w.job).toEqual({ outcome: 'failed', reason: 'BackoffLimitExceeded', failedPods: 2 });
  });

  it('reads Complete, ignores a condition whose status is not True, and reports pod failures while it retries', () => {
    expect(job({ succeeded: 1, conditions: [{ type: 'Complete', status: 'True' }] }).job).toEqual({ outcome: 'complete' });
    expect(job({ failed: 1, active: 1, conditions: [{ type: 'Failed', status: 'False' }] }).job).toEqual({ outcome: 'running', failedPods: 1 });
    expect(job({ active: 1 }).job).toEqual({ outcome: 'running' });
  });

  it('only Jobs carry an outcome', () => {
    const c = mapKubeObjects('c', { ...empty, replicasets: [], pods: [], deployments: [{ metadata: { name: 'd', namespace: 'n' }, spec: { replicas: 1 }, status: { conditions: [{ type: 'Failed', status: 'True' }] } }] }, { observedAt: 'now' });
    expect(c.workloads[0].job).toBeUndefined();
  });
});

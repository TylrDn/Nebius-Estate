import { alertId, alertValueText, classifyRule, tidyAlertTitle, evalSignalExpr, headingAnchor, markdownAnchors, markdownSection, metricNames, parseDuration, parseRuleFile, parseSignalExpr, renderTemplate, stepRule, trailingRunStart } from './alerts';
import type { SignalSeries } from './alerts';

describe('rule files', () => {
  it('parse durations as Prometheus does', () => {
    expect(parseDuration('5m')).toBe(300);
    expect(parseDuration('1h30m')).toBe(5400);
    expect(parseDuration('0m')).toBe(0);
    expect(parseDuration(undefined)).toBe(0);
    expect(parseDuration('five')).toBeUndefined();
  });

  it('extract metric names, not functions, labels or durations', () => {
    expect(metricNames('increase(DCGM_FI_DEV_XID_ERRORS[10m]) > 0')).toEqual(['DCGM_FI_DEV_XID_ERRORS']);
    expect(metricNames('kube_node_status_condition{condition="Ready",status="true"} == 0 and on(node) kube_node_labels{label_nip_nebius_io_gpu="true"}')).toEqual(['kube_node_status_condition', 'kube_node_labels']);
    expect(metricNames('histogram_quantile(0.95, sum by (le, model_name) (rate(vllm:e2e_request_latency_seconds_bucket[5m]))) > 10')).toEqual(['vllm:e2e_request_latency_seconds_bucket']);
  });

  it('classify where a rule can run: Nebius Monitoring, the portal, or an in-cluster Prometheus', () => {
    expect(classifyRule(['DCGM_FI_DEV_GPU_UTIL'])).toEqual({ source: 'nebius' });
    expect(classifyRule(['node_filesystem_avail_bytes'])).toEqual({ source: 'nebius' });
    expect(classifyRule(['nebius_estate_connector_failing'])).toEqual({ source: 'portal' });
    expect(classifyRule(['kube_deployment_status_replicas_available'])).toEqual({ source: 'in-cluster', missing: ['kube_deployment_status_replicas_available'] });
    expect(classifyRule(['DCGM_FI_DEV_GPU_UTIL', 'kube_node_labels']).source).toBe('in-cluster');
    // G3.1: dcgm-exporter's old throttle name alone needs dcgm-exporter; beside the name Nebius serves it is harmless.
    expect(classifyRule(['DCGM_FI_DEV_CLOCK_THROTTLE_REASONS'])).toEqual({ source: 'in-cluster', missing: ['DCGM_FI_DEV_CLOCK_THROTTLE_REASONS'] });
    expect(classifyRule(['DCGM_FI_DEV_CLOCKS_EVENT_REASONS', 'DCGM_FI_DEV_CLOCK_THROTTLE_REASONS', 'DCGM_FI_DEV_GPU_UTIL'])).toEqual({ source: 'nebius' });
  });

  it('read rules with their guided-fix annotations and report problems instead of throwing', () => {
    const { rules, problems } = parseRuleFile(
      `groups:
  - name: g
    rules:
      - record: x:sum
        expr: sum(x)
      - alert: GpuHot
        expr: DCGM_FI_DEV_GPU_TEMP >= 85
        for: 5m
        labels: { severity: critical }
        annotations:
          summary: hot
          runbook: runbooks/portal-alerts.md#gpu-hot
          docs: https://docs.nebius.com/compute/monitoring/virtual-machines#gpu-monitoring-metrics
          checks: |
            one
            two
          fix: lower the load
      - alert: Bad
        expr: x
        for: soon
        labels: { severity: loud }
`,
      'platform/alerts/portal/x.yaml',
    );
    expect(rules.map(r => r.name)).toEqual(['GpuHot', 'Bad']);
    expect(rules[0]).toMatchObject({ id: 'platform/alerts/portal/x.yaml#GpuHot', forSeconds: 300, severity: 'critical', checks: ['one', 'two'], fix: 'lower the load', source: 'nebius' });
    expect(problems.map(p => p.message)).toEqual(['Bad: for: "soon" is not a duration', 'Bad: severity "loud" is not one of critical, warning, info']);
    expect(parseRuleFile('groups: [', 'f').problems[0].message).toMatch(/not valid YAML/);
  });
});

describe('Markdown anchors (runbook links)', () => {
  it('slug headings as GitHub does', () => {
    expect(headingAnchor("2. Quota in the stage's project")).toBe('2-quota-in-the-stages-project');
    expect(headingAnchor('GPU not visible to pods (`nvidia.com/gpu` allocatable = 0)')).toBe('gpu-not-visible-to-pods-nvidiacomgpu-allocatable--0');
  });
  it('list anchors outside code fences, numbering duplicates, and cut one section', () => {
    const md = '# T\n## A\ntext\n```\n## not a heading\n```\n### A1\nmore\n## B\nb\n## A\n';
    expect(markdownAnchors(md)).toEqual(['t', 'a', 'a1', 'b', 'a-1']);
    expect(markdownSection(md, 'a')).toBe('## A\ntext\n```\n## not a heading\n```\n### A1\nmore');
    expect(markdownSection(md, 'missing')).toBeUndefined();
  });
});

describe('portal signal expressions', () => {
  const signals: SignalSeries[] = [
    { metric: 'nebius_estate_connector_failing', labels: { connector: 'nebius-inventory' }, value: 1 },
    { metric: 'nebius_estate_connector_failing', labels: { connector: 'prometheus' }, value: 0 },
    { metric: 'nebius_estate_maintenance_scheduled', labels: { project: 'p' }, value: 3 },
  ];
  it('parse a selector with matchers and a comparison', () => {
    expect(parseSignalExpr('nebius_estate_connector_failing{connector!~"mk8s:.*"} > 0')).toEqual({ metric: 'nebius_estate_connector_failing', matchers: [{ label: 'connector', op: '!~', value: 'mk8s:.*' }], op: '>', threshold: 0 });
    expect(parseSignalExpr('rate(x[5m]) > 0')).toBeUndefined();
  });
  it('select the series that hold', () => {
    expect(evalSignalExpr(parseSignalExpr('nebius_estate_connector_failing > 0')!, signals).map(s => s.labels.connector)).toEqual(['nebius-inventory']);
    expect(evalSignalExpr(parseSignalExpr('nebius_estate_connector_failing{connector="prometheus"}')!, signals)).toHaveLength(1);
    expect(evalSignalExpr(parseSignalExpr('nebius_estate_connector_failing{connector=~"nebius-.*"} > 0')!, signals)).toHaveLength(1);
    expect(evalSignalExpr(parseSignalExpr('nebius_estate_maintenance_scheduled')!, signals)).toHaveLength(1);
  });
});

describe('alert state machine', () => {
  const rule = { id: 'f#GpuHot', name: 'GpuHot', forSeconds: 300, severity: 'critical' as const, source: 'nebius' as const };
  const at = (min: number) => new Date(Date.parse('2026-10-11T08:00:00Z') + min * 60_000);
  const labels = { instance_id: 'computeinstance-1' };

  it('is pending until the condition has held for `for:`, then firing, then resolved', () => {
    const t0 = stepRule(rule, [], [{ labels, value: 86 }], at(0), 'q');
    expect(t0.instances[0]).toMatchObject({ state: 'pending', activeAt: at(0).toISOString() });
    expect(t0.transitions.map(t => `${t.from}>${t.to}`)).toEqual(['inactive>pending']);
    const t1 = stepRule(rule, t0.instances, [{ labels, value: 88 }], at(3), 'q');
    expect(t1.instances[0].state).toBe('pending');
    expect(t1.transitions).toEqual([]);
    const t2 = stepRule(rule, t1.instances, [{ labels, value: 90 }], at(5), 'q');
    expect(t2.instances[0]).toMatchObject({ state: 'firing', firedAt: at(5).toISOString(), activeAt: at(0).toISOString(), value: 90 });
    const t3 = stepRule(rule, t2.instances, [], at(20), 'q');
    expect(t3.instances[0]).toMatchObject({ state: 'resolved', resolvedAt: at(20).toISOString(), firedAt: at(5).toISOString() });
    expect(t3.transitions.map(t => `${t.from}>${t.to}`)).toEqual(['firing>resolved']);
  });

  it('fires within one evaluation when history shows the condition already held for `for:`', () => {
    const r = stepRule(rule, [], [{ labels, value: 87, since: at(-6).toISOString() }], at(0), 'q');
    expect(r.instances[0]).toMatchObject({ state: 'firing', activeAt: at(-6).toISOString() });
  });

  it('starts a new episode after a resolve, and a zero `for:` fires at once', () => {
    const fired = stepRule({ ...rule, forSeconds: 0 }, [], [{ labels, value: 1 }], at(0), 'q');
    expect(fired.instances[0].state).toBe('firing');
    const resolved = stepRule({ ...rule, forSeconds: 0 }, fired.instances, [], at(1), 'q');
    const again = stepRule(rule, resolved.instances, [{ labels, value: 1 }], at(2), 'q');
    expect(again.instances[0]).toMatchObject({ state: 'pending', activeAt: at(2).toISOString() });
    expect(again.instances[0].firedAt).toBeUndefined();
  });

  it('keeps what the value counts on the alert, so it reads with its unit (#42)', () => {
    const valueKind = { quotaUnit: 'bytes', meaning: 'below the tenant limit' };
    const r = stepRule(rule, [], [{ labels, value: 3848290697216, valueKind }], at(0), 'q');
    expect(r.instances[0].valueKind).toEqual(valueKind);
    expect(stepRule(rule, [], [{ labels, value: 1 }], at(0), 'q').instances[0]).not.toHaveProperty('valueKind');
  });

  it('identifies an alert by rule and label set, whatever the label order', () => {
    expect(alertId('r', { a: '1', b: '2' })).toBe(alertId('r', { b: '2', a: '1' }));
    expect(alertId('r', { a: '1' })).not.toBe(alertId('r', { a: '2' }));
  });
});

describe('alert helpers', () => {
  it('render annotation templates with labels and the value', () => {
    // eslint-disable-next-line no-template-curly-in-string
    expect(renderTemplate('Xid on {{ $labels.Hostname }} GPU {{$labels.gpu}} = {{ $value }}', { Hostname: 'n1' }, 2.3456)).toBe('Xid on n1 GPU  = 2.35');
    // A missing label renders empty (Prometheus semantics): a rule names both the dcgm-exporter and the Nebius label.
    expect(renderTemplate('{{ $labels.Hostname }}{{ $labels.instance_id }} GPU {{ $labels.gpu }}{{ $labels.uuid }}', { instance_id: 'computeinstance-1', uuid: 'GPU-1' }, 0)).toBe('computeinstance-1 GPU-1');
  });
  it('render a value in hours as a time ahead, with the formatter every page uses (F1.3)', () => {
    // eslint-disable-next-line no-template-curly-in-string
    expect(renderTemplate('Maintenance {{ $labels.name }} {{ $value | untilHours }}', { name: 'm' }, 1198.3)).toBe('Maintenance m in 49 d');
    expect(renderTemplate('{{$value|untilHours}}', {}, 0)).toBe('now');
  });
  it('find how long a condition has held from a range query, breaking on gaps', () => {
    const now = 10_000;
    expect(trailingRunStart([[now - 600, 1], [now - 300, 1], [now - 240, 1], [now - 180, 1], [now - 120, 1], [now - 60, 1]], 60, now)).toBe(now - 300);
    expect(trailingRunStart([[now - 900, 1]], 60, now)).toBeUndefined();
    expect(trailingRunStart([], 60, now)).toBeUndefined();
  });
});

describe('alertValueText (#42: "Value: 3,848,290,697,216" was 3.5 TiB of a byte quota)', () => {
  it('a byte quota reads in GiB / TiB with what the amount is', () => {
    expect(alertValueText(3848290697216, { quotaUnit: 'bytes', meaning: 'below the tenant limit' })).toBe('3.5 TiB below the tenant limit');
    expect(alertValueText(987, { quotaUnit: 'count', meaning: 'below the tenant limit' })).toBe('987 below the tenant limit');
  });

  it('a quota line amount reads in its unit (sizes in GiB, vCPU, GPUs)', () => {
    expect(alertValueText(4373, { quota: 'compute.disk.size.network-ssd', meaning: 'short' })).toBe('4.27 TiB short');
    expect(alertValueText(16, { quota: 'compute.instance.non-gpu.vcpu' })).toBe('16 vCPU');
  });

  it('a plain unit word follows the number; with nothing known, the number alone', () => {
    expect(alertValueText(48.5, { unit: 'h', meaning: 'until it starts' })).toBe('48.5 h until it starts');
    expect(alertValueText(3, { meaning: 'failed syncs in a row' })).toBe('3 failed syncs in a row');
    expect(alertValueText(0.934)).toBe('0.93');
  });
});

describe('alert titles never say "GPU GPU-" (#66)', () => {
  it('a summary "GPU {{ $labels.uuid }}" with a UUID label reads "GPU-<uuid>" once', () => {
    expect(renderTemplate('GPU {{ $labels.gpu }}{{ $labels.uuid }} on {{ $labels.instance_id }} idle for an hour', { gpu: '', uuid: 'GPU-0000mock-aaaa', instance_id: 'vm-1' }, 0)).toBe('GPU-0000mock-aaaa on vm-1 idle for an hour');
    expect(renderTemplate('GPU {{ $labels.gpu }} on vm', { gpu: '0' }, 0)).toBe('GPU 0 on vm');
  });
  it('a title stored with the repetition reads without it', () => {
    expect(tidyAlertTitle('Xid error on vm-1 GPU GPU-0000mock-aaaa')).toBe('Xid error on vm-1 GPU-0000mock-aaaa');
    expect(tidyAlertTitle('GPU node gpu-1 NotReady')).toBe('GPU node gpu-1 NotReady');
  });
});

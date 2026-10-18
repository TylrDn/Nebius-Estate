#!/usr/bin/env bash
# workloads/ml-services/check-job/mlflow_check.py (the check Job's mlflow container). 2026-10-12 the
# check ran 19:32Z from a pod in the R1 cluster against MLflow's private-tracking endpoint (cluster
# RUNNING since 19:12Z) and recorded only "MlflowException: ... HTTPSConnectionPool(host=..." cut at
# 300 characters, before the cause. The check now names the cause class, keeps the message bounded
# with its tail (where requests puts the cause), and records the endpoint host plus a DNS and a TCP
# probe. mlflow is stubbed (no network, no server); the TCP probe runs against a local socket.
# shellcheck source=tests/scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
test_name=mlflow-check
python3 -I - "${repo_root}/workloads/ml-services/check-job/mlflow_check.py" <<'PY' || fail "see the assertion above"
import contextlib, importlib.util, io, json, os, socket, sys, types

spec = importlib.util.spec_from_file_location("mlflow_check", sys.argv[1])
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
REAL = (m.resolve, m.connect)

# The exception chain mlflow 2.x raises: requests' ConnectionError wraps urllib3's MaxRetryError,
# whose .reason is the cause; MlflowException is raised while handling it (implicit __context__).
class NameResolutionError(Exception): pass
class ConnectTimeoutError(Exception): pass
class NewConnectionError(Exception): pass
class SSLError(Exception): pass
class ResponseError(Exception): pass
class MaxRetryError(Exception):
    def __init__(self, reason): super().__init__(f"Max retries exceeded (Caused by {type(reason).__name__}({reason}))"); self.reason = reason
class ConnectionError_(Exception): pass
ConnectionError_.__name__ = "ConnectionError"
class MlflowException(Exception): pass
HOST = "private-tracking-mock.example.invalid"
PREFIX = "API request to https://%s/api/2.0/mlflow/experiments/get-by-name failed with exception HTTPSConnectionPool(host='%s', port=443): Max retries exceeded with url: /api/2.0/mlflow/experiments/get-by-name?experiment_name=nip-check " % (HOST, HOST)

def raised(inner, text):
    try:
        try:
            raise ConnectionError_(MaxRetryError(inner))
        except ConnectionError_ as e:
            raise MlflowException(PREFIX + text)
    except MlflowException as e:
        return e

def fake_mlflow(exc=None):
    mod = types.ModuleType("mlflow"); mod.__version__ = "2.21.2"
    def boom(*a, **k):
        if exc: raise exc
    mod.set_tracking_uri = lambda uri: None
    mod.set_experiment = boom
    tr = types.ModuleType("mlflow.tracking"); tr.MlflowClient = object; mod.tracking = tr
    sys.modules["mlflow"] = mod; sys.modules["mlflow.tracking"] = tr

def run(exc=None, dns=True, tcp=True):
    fake_mlflow(exc)
    m.resolve = (lambda h, p: ["10.0.0.5"]) if dns else (lambda h, p: (_ for _ in ()).throw(socket.gaierror(-2, "Name or service not known")))
    m.connect = (lambda a, p, t: None) if tcp else (lambda a, p, t: (_ for _ in ()).throw(ConnectionRefusedError(111, "Connection refused")))
    os.environ.update(MLFLOW_HOST=HOST, RUN_ID="t", MLFLOW_EXPERIMENT="nip-check")
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        rc = m.main()
    line = [l for l in out.getvalue().splitlines() if l.startswith("NIP-CHECK ")][-1]
    return rc, json.loads(line[len("NIP-CHECK "):])

# 1. The 2026-10-12 shape: a long prefix, the cause at the end.
long_cause = "(Caused by NameResolutionError(\"<urllib3.connection.HTTPSConnection object at 0x7f>: Failed to resolve '%s' ([Errno -2] Name or service not known)\"))" % HOST
rc, r = run(raised(NameResolutionError("Failed to resolve"), long_cause))
assert rc == 1 and r["ok"] is False, r
assert r["endpoint_host"] == HOST and r["tracking_uri"] == "https://" + HOST, r
assert r["error_class"] == "MlflowException" and r["cause"] == "name_resolution" and r["cause_class"] == "NameResolutionError", r
assert len(r["error"]) <= m.MAX_ERROR and "Name or service not known" in r["error"], r["error"]
assert r["probe"]["dns"]["ok"] is True and r["probe"]["dns"]["private"] is True and r["probe"]["tcp"]["ok"] is True, r["probe"]
assert "10.0.0.5" not in json.dumps(r), "addresses are summarised, not recorded"
print("ok   mlflow-check: NameResolutionError named, message bounded with its cause, host and probes recorded")

# 2. Each cause class, from the exception chain.
for inner, want in [(ConnectTimeoutError("timed out"), "connect_timeout"),
                    (NewConnectionError("[Errno 111] Connection refused"), "connection_refused"),
                    (SSLError("CERTIFICATE_VERIFY_FAILED"), "ssl"),
                    (ResponseError("too many 503 error responses"), "http_status")]:
    rc, r = run(raised(inner, "(Caused by %s)" % type(inner).__name__))
    assert r["cause"] == want, (want, r)
assert r["http_status"] == 503, r
# An HTTP error answered by the server (RestException): the status comes from the message.
rc, r = run(MlflowException("API request to endpoint /api/2.0/mlflow/runs/create failed with error code 401 != 200. Response body: 'Unauthorized'"))
assert r["cause"] == "http_status" and r["http_status"] == 401, r
# A JSON error body (RestException, mlflow/utils/rest_utils.py) carries its status.
class RestException(Exception):
    def get_http_status_code(self): return 403
rc, r = run(RestException("PERMISSION_DENIED: denied"))
assert r["cause"] == "http_status" and r["http_status"] == 403 and r["cause_class"] == "RestException", r
# mlflow 2.21.2 raises timeouts "from" requests' ConnectTimeout (explicit __cause__).
class ConnectTimeout(Exception): pass
try:
    try: raise ConnectTimeout("connect timeout=120")
    except ConnectTimeout as to: raise MlflowException("API request to x failed with timeout exception") from to
except MlflowException as e: rc, r = run(e)
assert r["cause"] == "connect_timeout" and r["cause_class"] == "ConnectTimeout" and r["http_status"] is None, r
# Text only, no chain: still classified.
rc, r = run(RuntimeError("HTTPSConnectionPool(host='x', port=443): Max retries exceeded (Caused by ConnectTimeoutError(...))"))
assert r["cause"] == "connect_timeout" and r["error_class"] == "RuntimeError", r
print("ok   mlflow-check: connect timeout, refused, SSL and HTTP status (503 from retries, 401 from the server) are told apart")

# 3. The probe fails first: no MLflow call (its retries would outlast the Job deadline), cause from the probe.
rc, r = run(dns=False)
assert rc == 1 and r["cause"] == "name_resolution" and r["cause_source"] == "probe" and r["probe"]["tcp"]["ok"] is None, r
assert r["client_call"].startswith("not attempted"), r
rc, r = run(tcp=False)
assert r["cause"] == "connection_refused" and r["probe"]["tcp"]["error_class"] == "ConnectionRefusedError", r
print("ok   mlflow-check: a failed DNS or TCP probe is the cause; the client is not called")

# 4. The real probe against local sockets: open port connects, closed port is refused.
m.resolve, m.connect = REAL
srv = socket.socket(); srv.bind(("127.0.0.1", 0)); srv.listen(1); port = srv.getsockname()[1]
p = m.probe("127.0.0.1", port, 2)
assert p["dns"]["ok"] and p["tcp"]["ok"], p
srv.close()
p = m.probe("127.0.0.1", port, 2)
assert p["tcp"]["ok"] is False and p["tcp"]["error_class"] == "ConnectionRefusedError", p
print("ok   mlflow-check: the TCP probe connects to an open port and reports a refused one")

# 5. Success records the run; skipped without a host.
fake_mlflow()
class _Run:
    info = types.SimpleNamespace(run_id="0123456789abcdef", status="FINISHED")
    data = types.SimpleNamespace(metrics={"smoke": 1.0})
    def __enter__(self): return self
    def __exit__(self, *a): return False
sys.modules["mlflow"].start_run = lambda **k: _Run()
sys.modules["mlflow"].log_param = sys.modules["mlflow"].log_metric = lambda *a: None
sys.modules["mlflow.tracking"].MlflowClient = lambda: types.SimpleNamespace(get_run=lambda rid: _Run())
m.resolve, m.connect = (lambda h, p: ["10.0.0.5"]), (lambda a, p, t: None)
out = io.StringIO()
with contextlib.redirect_stdout(out):
    assert m.main() == 0
r = json.loads(out.getvalue().split("NIP-CHECK ", 1)[1])
assert r["ok"] and r["run_id"] == "0123456789abcdef" and r["metric_smoke"] == 1.0 and "error" not in r and r["endpoint_host"] == HOST, r
os.environ["MLFLOW_HOST"] = ""
out = io.StringIO()
with contextlib.redirect_stdout(out):
    assert m.main() == 0
assert json.loads(out.getvalue().split("NIP-CHECK ", 1)[1]) == {"check": "mlflow", "skipped": True}
print("ok   mlflow-check: an empty MLFLOW_HOST is skipped")
PY

test_name=mlflow-check-wiring
kdir="${repo_root}/workloads/ml-services/check-job"
grep -q 'command: \["python", "/opt/nip-check/mlflow_check.py"\]' "${kdir}/job.yaml" || fail "the mlflow container runs mlflow_check.py"
grep -q '{ name: scripts, configMap: { name: ml-services-check-scripts } }' "${kdir}/job.yaml" || fail "the Job mounts ConfigMap ml-services-check-scripts"
grep -A3 'name: ml-services-check-scripts' "${kdir}/kustomization.yaml" | grep -q 'mlflow_check.py' || fail "kustomize generates the ConfigMap from mlflow_check.py"
ok "the Job runs the tested file, generated into its ConfigMap by kustomize"

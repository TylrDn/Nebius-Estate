"""MLflow client check for the ml-services check Job (mounted from ConfigMap ml-services-check-scripts).

Prints one `NIP-CHECK {json}` line and exits 1 when the check fails, 0 when it passes or is skipped
(MLFLOW_HOST empty). Logs a run with metric smoke=1 and reads it back
(docs mlflow/quickstart#configure-connection-to-mlflow-tracking).

Before the client, a DNS and a TCP probe of <MLFLOW_HOST>:443: the private-tracking endpoint is
reachable "from the network where the cluster is located" (docs mlflow/clusters/manage.md, Access);
whether a pod's DNS resolves it and its traffic reaches it is what the probe records. When the probe
fails the client is not called: its retries (MLFLOW_HTTP_REQUEST_MAX_RETRIES) would outlast the
Job's activeDeadlineSeconds and leave no NIP-CHECK line at all.

On failure the record names the cause (name_resolution | connect_timeout | connection_refused |
ssl | http_status | read_timeout | other) from the exception chain and its text, the innermost
class, and the message bounded to MAX_ERROR characters with its head and tail kept: requests puts
the cause at the end ("... (Caused by NameResolutionError(...))"), which a plain [:300] cut off on
2026-10-12. Resolved addresses are summarised (count, all private or not), never recorded.
"""
import ipaddress
import json
import os
import re
import socket
import sys

MAX_ERROR = 600
PORT = 443

# Class names first (innermost wins), then the text: mlflow re-raises with the urllib3 cause only
# in the message on some paths.
CAUSES = [
    ("name_resolution", ("NameResolutionError", "gaierror"),
     r"NameResolutionError|Failed to resolve|Name or service not known|nodename nor servname|Temporary failure in name resolution|getaddrinfo failed"),
    ("ssl", ("SSLError", "SSLCertVerificationError", "SSLZeroReturnError"), r"SSLError|CERTIFICATE_VERIFY_FAILED|SSL:|certificate verify failed"),
    ("connect_timeout", ("ConnectTimeoutError", "ConnectTimeout"), r"ConnectTimeoutError|ConnectTimeout|connect timeout|Connection to \S+ timed out"),
    ("connection_refused", ("ConnectionRefusedError",), r"Connection refused|ConnectionRefusedError|Errno 111\b|Errno 61\b"),
    ("read_timeout", ("ReadTimeoutError", "ReadTimeout"), r"ReadTimeoutError|ReadTimeout|Read timed out"),
    ("http_status", ("ResponseError", "HTTPError", "RestException"), r"too many \d{3} error responses|error code \d{3}|status code \d{3}"),
]
STATUS_RE = re.compile(r"too many (\d{3}) error responses|error code (\d{3})|status code[: ]+(\d{3})")


def bounded(text, limit=MAX_ERROR):
    """The text cut to `limit` characters, keeping a third from the head and the rest from the tail."""
    if len(text) <= limit:
        return text
    head = limit // 3
    tail = limit - head - 5
    return text[:head] + " ... " + text[-tail:]


def chain(exc):
    """exc and every exception it wraps: __cause__, __context__, urllib3's .reason, requests' args[0]."""
    seen, out, todo = set(), [], [exc]
    while todo:
        e = todo.pop(0)
        if e is None or id(e) in seen or not isinstance(e, BaseException):
            continue
        seen.add(id(e))
        out.append(e)
        todo += [e.__cause__, e.__context__, getattr(e, "reason", None)]
        todo += [a for a in getattr(e, "args", ()) if isinstance(a, BaseException)]
    return out


def classify(exc):
    """{cause, cause_class, http_status} for an exception from the MLflow client."""
    excs = chain(exc)
    names = [type(e).__name__ for e in excs]
    text = " | ".join("%s: %s" % (type(e).__name__, e) for e in excs)
    cause, cause_class = "other", names[-1]
    for name, classes, pattern in CAUSES:
        hit = next((n for n in reversed(names) if n in classes), None)
        if hit:
            cause, cause_class = name, hit
            break
    else:
        for name, _, pattern in CAUSES:
            if re.search(pattern, text, re.I):
                cause = name
                break
    status = None
    for e in excs:
        code = getattr(getattr(e, "response", None), "status_code", None)
        # RestException (a JSON error body from the server) maps its error_code to a status; a plain
        # MlflowException would map its default INTERNAL_ERROR to 500, so only RestException is asked.
        if code is None and type(e).__name__ == "RestException" and hasattr(e, "get_http_status_code"):
            code = e.get_http_status_code()
        if isinstance(code, int):
            status = code
    if status is None:
        hit = STATUS_RE.search(text)
        status = int(next(g for g in hit.groups() if g)) if hit else None
    if status is not None and cause == "other":
        cause = "http_status"
    return {"cause": cause, "cause_class": cause_class, "http_status": status}


def resolve(host, port):
    return sorted({info[4][0] for info in socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)})


def connect(addr, port, timeout):
    socket.create_connection((addr, port), timeout=timeout).close()


def probe(host, port=PORT, timeout=5.0):
    """DNS then TCP to host:port. Addresses are summarised, not recorded."""
    try:
        addrs = resolve(host, port)
    except OSError as e:
        return {"dns": {"ok": False, "error_class": type(e).__name__, "error": bounded(str(e), 200)},
                "tcp": {"ok": None, "skipped": "no address"}}
    private = all(ipaddress.ip_address(a.split("%")[0]).is_private for a in addrs) if addrs else None
    dns = {"ok": bool(addrs), "addresses": len(addrs), "private": private}
    if not addrs:
        return {"dns": dns, "tcp": {"ok": None, "skipped": "no address"}}
    try:
        connect(addrs[0], port, timeout)
        return {"dns": dns, "tcp": {"ok": True, "port": port}}
    except OSError as e:  # socket.timeout is an OSError
        return {"dns": dns, "tcp": {"ok": False, "port": port, "error_class": type(e).__name__,
                                    "errno": getattr(e, "errno", None), "error": bounded(str(e) or type(e).__name__, 200)}}


def probe_cause(p):
    if not p["dns"]["ok"]:
        return "name_resolution", p["dns"].get("error_class")
    cls = p["tcp"].get("error_class")
    if cls in ("ConnectionRefusedError",):
        return "connection_refused", cls
    if cls in ("timeout", "TimeoutError"):
        return "connect_timeout", cls
    return "other", cls


def main():
    out = {"check": "mlflow"}
    host = os.environ.get("MLFLOW_HOST", "")
    if not host:
        print("NIP-CHECK " + json.dumps({**out, "skipped": True}))
        return 0
    uri = "https://" + host
    experiment = os.environ.get("MLFLOW_EXPERIMENT") or "nip-check"
    out.update(endpoint_host=host, tracking_uri=uri, experiment=experiment)
    out["probe"] = probe(host)
    ok = False
    if not out["probe"]["tcp"].get("ok"):
        cause, cls = probe_cause(out["probe"])
        out.update(client_call="not attempted: the %s probe failed" % ("DNS" if not out["probe"]["dns"]["ok"] else "TCP"),
                   cause=cause, cause_class=cls, cause_source="probe", http_status=None)
    else:
        try:
            import mlflow
            from mlflow.tracking import MlflowClient
            mlflow.set_tracking_uri(uri)
            mlflow.set_experiment(experiment)
            with mlflow.start_run(run_name="nip-check-" + os.environ.get("RUN_ID", "manual")) as run:
                mlflow.log_param("source", "workloads/ml-services/check-job")
                mlflow.log_metric("smoke", 1.0)
            got = MlflowClient().get_run(run.info.run_id)
            ok = got.info.status == "FINISHED" and got.data.metrics.get("smoke") == 1.0
            out.update(run_id=run.info.run_id, status=got.info.status, metric_smoke=got.data.metrics.get("smoke"),
                       client_version=mlflow.__version__)
        except Exception as e:  # any failure is the check's result, printed for the record
            out.update(error_class=type(e).__name__, error=bounded("%s: %s" % (type(e).__name__, e)),
                       cause_source="client", **classify(e))
    out["ok"] = ok
    print("NIP-CHECK " + json.dumps(out))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())

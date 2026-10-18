# shellcheck shell=bash
# One-shot pod for the validation steps (sourced; needs kubectl and jq), instead of
# `kubectl run --rm -i`: that attaches only once the pod runs and waits --pod-running-timeout
# (default 1m0s) for it, then fails with "error: timed out waiting for the condition" and no reason
# (02-interconnect on gpu-l40s-a, 2026-10-12). pod_run waits for the pod to FINISH, up to a deadline
# the caller sets, stops early when the pod cannot start, and says why it did not finish.
#   pod_run <name> <image> <overrides-json> <timeout_s> <log_file>
#     The container log goes to <log_file>; one JSON object goes to stdout:
#       {pod, outcome, phase, exit_code, waiting_reason, message, node, waited_s, timeout_s}
#     outcome: succeeded | failed (the container ran and exited non-zero) | start_failed (the image
#     or the container config cannot start: no point waiting; ErrImagePull alone is retried by the kubelet,
#     so the step waits for ImagePullBackOff) | timeout | create_failed
#   POD_POLL_S (default 5): seconds between polls.
POD_START_FAILURES='ImagePullBackOff|InvalidImageName|ErrImageNeverPull|CreateContainerConfigError|CreateContainerError|RunContainerError'
pod_run() {
  local name="$1" image="$2" overrides="$3" timeout_s="$4" log="$5" start=$SECONDS pod='{}' phase reason outcome err
  : >"$log"
  kubectl delete pod "$name" --ignore-not-found >/dev/null 2>&1 || true # left by an aborted run
  if ! err="$(kubectl run "$name" --restart=Never --quiet --image="$image" --overrides="$overrides" 2>&1 >/dev/null)"; then
    jq -nc --arg p "$name" --arg m "$err" --argjson t "$timeout_s" \
      '{pod:$p,outcome:"create_failed",phase:null,exit_code:null,waiting_reason:null,message:($m|.[0:500]),node:null,waited_s:0,timeout_s:$t}'
    return 0
  fi
  while :; do
    pod="$(kubectl get pod "$name" -o json 2>/dev/null)" || pod='{}'
    phase="$(jq -r '.status.phase // "Unknown"' <<<"$pod")"
    reason="$(jq -r '[.status.containerStatuses[]?.state.waiting.reason // empty] | first // empty' <<<"$pod")"
    if [[ "$phase" == Succeeded ]]; then outcome=succeeded; break; fi
    if [[ "$phase" == Failed ]]; then outcome=failed; break; fi
    if [[ -n "$reason" && "$reason" =~ ^(${POD_START_FAILURES})$ ]]; then outcome=start_failed; break; fi
    if (( SECONDS - start >= timeout_s )); then outcome=timeout; break; fi
    sleep "${POD_POLL_S:-5}"
  done
  kubectl logs "$name" >"$log" 2>/dev/null || true
  kubectl delete pod "$name" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  jq -c --arg p "$name" --arg o "$outcome" --argjson w "$((SECONDS - start))" --argjson t "$timeout_s" '{
      pod:$p, outcome:$o, phase:(.status.phase // null),
      exit_code:([.status.containerStatuses[]?.state.terminated.exitCode // empty] | first // null),
      waiting_reason:([.status.containerStatuses[]?.state.waiting.reason // empty] | first // null),
      message:(([.status.containerStatuses[]?.state.waiting.message // empty] | first)
               // ([.status.conditions[]? | select(.type == "PodScheduled" and .status == "False") | "\(.reason): \(.message)"] | first)
               // ([.status.containerStatuses[]?.state.terminated.reason // empty] | first) // null),
      node:(.spec.nodeName // null), waited_s:$w, timeout_s:$t}' <<<"$pod"
}

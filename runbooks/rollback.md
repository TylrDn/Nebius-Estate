# Rollback and recovery

## Workload drill (inference) — run once per new cluster and record the timings

```bash
# 0. baseline
kubectl -n inference rollout history deploy/vllm
tests/validate/04-workload.sh                              # records model + image

# 1. change: switch overlay (new hashed ConfigMap -> new ReplicaSet)
kubectl apply -k workloads/inference/overlays/qwen2.5-7b
kubectl -n inference rollout status deploy/vllm --timeout=20m
tests/validate/04-workload.sh                              # model must now be the 7B

# 2. break: kill the serving pod and watch it come back (Recreate strategy)
kubectl -n inference delete pod -l app.kubernetes.io/name=vllm
kubectl -n inference rollout status deploy/vllm --timeout=20m

# 3. roll back: previous ReplicaSet = previous image + previous hashed ConfigMap
kubectl -n inference rollout undo deploy/vllm
kubectl -n inference rollout status deploy/vllm --timeout=20m
tests/validate/04-workload.sh                              # model must be the 1.5B again

# 4. make it declarative
kubectl apply -k workloads/inference/overlays/qwen2.5-1.5b # no-op if 3 restored the same spec
```

Record in `docs/evidence/`: time to Ready after each step, and the ConfigMap names from
`kubectl -n inference get cm` before/after.

## Platform

Roll back one component at a time (P5): revert the Terraform change in git, `make plan`,
review, `make apply CONFIRM=yes`; re-run `tests/validate/00..03`. Marketplace releases are
replaced, not patched in place; a failed one shows `status.error_message` in state.
Expected: the plan shows only the reverted component, and each validate step writes
`"status": "pass"` to `results/<step>.json` (`tests/validate/lib.sh` `record`).

## Infrastructure

Reverting a node-group template change is another rolling replace of every node
([blast radius](../docs/change-management.md#kinds-of-change-and-their-blast-radius)). For a
group you cannot afford to replace in place: create a new group with the corrected template,
drain the old one (`kubectl drain --ignore-daemonsets --delete-emptydir-data`), then remove it.
Expected: `kubectl get nodes` shows only nodes of the corrected group, all `Ready`, and
`tests/validate/00-nodes.sh` passes.
Never switch an existing GPU node group between driver paths (ADR-0003).

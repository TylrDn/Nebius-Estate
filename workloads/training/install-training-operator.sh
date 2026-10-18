#!/usr/bin/env bash
# Install the Kubeflow Training Operator (MPIJob/PyTorchJob) exactly as the Nebius
# NCCL-test doc does, pinned to the commit of a release tag.
# https://docs.nebius.com/kubernetes/gpu/nccl-test
# The doc applies ?ref=<tag>; a tag can be moved, so kustomize fetches the commit that tag pointed
# to when it was reviewed (platform/versions.yaml workloads.kubeflow-training-operator.ref; make pins
# checks both). Override both together: TRAINING_OPERATOR_VERSION and TRAINING_OPERATOR_COMMIT.
set -euo pipefail
VERSION="${TRAINING_OPERATOR_VERSION:-v1.9.3}"
COMMIT="${TRAINING_OPERATOR_COMMIT:-c77ee3ff4d21aa8e5027580d83361c1a426ee789}"
[[ "${COMMIT}" =~ ^[0-9a-f]{40}$ ]] || { echo "TRAINING_OPERATOR_COMMIT must be a full 40-character commit sha" >&2; exit 2; }
echo "Training Operator ${VERSION} at commit ${COMMIT}"
kubectl apply --server-side -k "github.com/kubeflow/training-operator/manifests/overlays/standalone?ref=${COMMIT}"
kubectl -n kubeflow rollout status deploy/training-operator --timeout=5m
kubectl get crd mpijobs.kubeflow.org pytorchjobs.kubeflow.org

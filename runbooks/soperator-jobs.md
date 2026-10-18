# Soperator job runbook — submit, inspect, break, scale down

Prerequisite: `stacks/soperator` applied (the lab profile has one CPU worker; the NCCL step
needs a GPU nodeset of size ≥ 2 after a spend approval) and the login node reachable. The
recipe defines **no outputs**: the login load balancer IP comes from
`kubectl -n soperator get svc -l app.kubernetes.io/component=login -o jsonpath='{.items[0].status.loadBalancer.ingress[0].ip}'`
(or `terraform state show 'module.login_script.terraform_data.lb_service_ip'`). SSH as root
with the key you exported in `TF_VAR_slurm_login_ssh_root_public_keys`. Break-glass without
the public IP: `kubectl -n soperator exec login-0 -c sshd -- chroot /mnt/jail sinfo` — Slurm
commands run inside the jail root, which is also where SSH logins land. Host tools for
apply/destroy: `nebius` CLI, `kubectl`, `python3 >= 3.11`.

0. **Create a user** (as root on a login node; jobs run as that user, not root):
   `soperator-createuser <name> --without-sudo`, paste the user's SSH public key at the prompt
   ([users](https://docs.nebius.com/slurm-soperator/users/manage#how-to-create-a-user)); then
   `ssh <name>@<login IP>`.
1. **Submit a small job** (the lab profile's one CPU worker; no GPU request)
   ```bash
   sinfo                                  # expect the worker nodeset idle
   cat > hello.sbatch <<'EOF2'
   #!/bin/bash
   #SBATCH --job-name=nip-hello --nodes=1 --ntasks-per-node=1 --time=00:05:00
   srun hostname
   EOF2
   sbatch hello.sbatch && squeue -u "$USER"
   ```
   With an approved GPU nodeset, the GPU variant is
   `#SBATCH --nodes=2 --ntasks-per-node=1 --gpus-per-node=8` and `srun bash -c 'hostname; nvidia-smi -L | wc -l'`.
   Record: job id, time in queue, `sacct -j <id> --format=JobID,State,Elapsed,NodeList`.
2. **NCCL across workers (the same proof as `stacks/training`)** — the docs' job
   (https://docs.nebius.com/slurm-soperator/jobs/examples/nccl-all-reduce), H100/H200 values;
   B200 uses `--cpus-per-task=20` and `UCX_NET_DEVICES=mlx5_4:1,...,mlx5_11:1`, B300 the same
   devices with `--cpus-per-task=24`:
   ```bash
   mkdir -p results && cat > nccl_all_reduce.sbatch <<'EOF2'
   #!/bin/bash
   #SBATCH --job-name=nccl_all_reduce --time=30:00 --output=results/%x-%j.out --error=results/%x-%j.out
   #SBATCH --nodes=2 --gpus-per-node=8 --ntasks-per-node=8 --cpus-per-task=16 --mem=0
   export UCX_NET_DEVICES=mlx5_0:1,mlx5_1:1,mlx5_2:1,mlx5_3:1,mlx5_4:1,mlx5_5:1,mlx5_6:1,mlx5_7:1
   export NCCL_IB_QPS_PER_CONNECTION=2 NCCL_NVLS_ENABLE=1 NCCL_BUFFSIZE=8388608 NCCL_DEBUG=INFO
   srun --mpi=pmix all_reduce_perf_mpi -b 512M -e 16G -f 2 -g 1
   EOF2
   sbatch nccl_all_reduce.sbatch
   ```
   Pass bar: the job completes and meets the multi-node NCCL bar in
   [`tests/README.md`](../tests/README.md#training-stackstraining-testsvalidaterun-trainingsh)
   (`/IB`, `Out of bounds values : 0 OK`, ≥ 300 GB/s average on 2×8 H100/H200); busbw should rise
   with message size to a stable plateau. Record the full table with the exact flags.
3. **Inspect queue state** while a job runs: `squeue`, `scontrol show job <id>`,
   `kubectl -n soperator get pods` (worker pods map 1:1 to Slurm nodes).
4. **Kill a worker**: submit the step 1 job with `sbatch --requeue` (so the outcome is fixed), then
   `kubectl -n soperator delete pod worker-0` while it runs → expect the job to be requeued with the
   same ID (`squeue` state `RQ`/`REQUEUED`, then pending until resources return; with `--no-requeue` it
   fails instead), the pod to be recreated by the operator, and `sinfo` to show the
   node back. Requeue semantics: [Soperator jobs](https://docs.nebius.com/slurm-soperator/jobs)
   (`--requeue`), [manage jobs](https://docs.nebius.com/slurm-soperator/jobs/manage#requeue-a-job).
   Recovery time is not documented and has not been measured here: record it.
5. **Scale down** (do not assume it mirrors scale-up): set `size = 1` in the stage's `stage.tfvars` (lab profile: `profiles/lab.tfvars`),
   `make soperator-plan STAGE=<stage>`, review, `make soperator-apply CONFIRM=yes STAGE=<stage>` (in `sandbox` and `lab`
   the run's `make ttl-teardown STACK=soperator` job must still be running, or the apply refuses); then check `sinfo` for ghost nodes (operator limitation) and clean with
   `scontrol update NodeName=<n> State=FUTURE` or as the release notes instruct. Record what
   happened.
6. **Teardown**: `size = 0`, plan and apply as above, then `terraform destroy` of the recipe root
   (needs `python3 >= 3.11` for its CSI-disk cleanup); then `make leftovers-stage STAGE=<stage>`
   (the recipe labels nothing, so only the stage-wide check sees its residue) —
   the controller spool PVC disk and any `forbid_deletion` filesystem are the usual leftovers —
   and `kubectl config delete-context nebius-nip-slurm` (`runbooks/teardown.md`).

Evidence: `docs/evidence/<date>-<stage>-soperator-<what>.md` with release, image CUDA/driver, Slurm
version, node count, and the timings above.

"""Minimal DDP job that proves the stack: NCCL init across all ranks, an all-reduce
sanity check, and a few training steps of a synthetic model with per-step timing.
Not a benchmark; the numbers it prints are for comparing *runs of this script*.
Rank 0 prints one JSON line with samples/s (global batch / median step time after warm-up), which
tests/validate/ddp.sh records as results/ddp.json.
"""
import os, time, json
import torch
import torch.distributed as dist
import torch.nn as nn

def summary(times, world, batch):
    """Step-time summary from per-step seconds: the first 5 steps are warm-up and dropped."""
    warm = times[5:] or times
    p50 = sorted(warm)[len(warm) // 2]
    return {
        "world_size": world, "batch_per_rank": batch,
        "step_ms_p50": round(p50 * 1000, 2), "step_ms_max": round(max(warm) * 1000, 2),
        "samples_per_s": round(world * batch / p50, 1),
    }

def main():
    dist.init_process_group("nccl")
    rank, world = dist.get_rank(), dist.get_world_size()
    local_rank = int(os.environ.get("LOCAL_RANK", 0))
    torch.cuda.set_device(local_rank)
    dev = torch.device("cuda", local_rank)

    # 1. collective sanity: every rank contributes its rank id
    t = torch.tensor([float(rank)], device=dev)
    dist.all_reduce(t)
    assert t.item() == world * (world - 1) / 2, f"all_reduce mismatch on rank {rank}: {t.item()}"

    # 2. a synthetic model large enough to make gradient all-reduce visible
    hidden = int(os.environ.get("HIDDEN", 4096))
    steps = int(os.environ.get("STEPS", 20))
    batch = int(os.environ.get("BATCH", 64))  # rows per rank per step
    model = nn.Sequential(nn.Linear(hidden, hidden), nn.GELU(), nn.Linear(hidden, hidden)).to(dev)
    model = nn.parallel.DistributedDataParallel(model, device_ids=[local_rank])
    opt = torch.optim.AdamW(model.parameters(), lr=1e-4)
    x = torch.randn(batch, hidden, device=dev)
    times = []
    for step in range(steps):
        torch.cuda.synchronize(); t0 = time.perf_counter()
        loss = model(x).float().pow(2).mean()
        opt.zero_grad(set_to_none=True); loss.backward(); opt.step()
        torch.cuda.synchronize(); times.append(time.perf_counter() - t0)
    if rank == 0:
        print(json.dumps({
            **summary(times, world, batch), "hidden": hidden, "steps": steps,
            "params_M": round(sum(p.numel() for p in model.parameters()) / 1e6, 1),
            "torch": torch.__version__, "cuda": torch.version.cuda, "nccl": ".".join(map(str, torch.cuda.nccl.version())),
            "gpu": torch.cuda.get_device_name(dev),
        }))
    dist.barrier(); dist.destroy_process_group()

if __name__ == "__main__":
    main()

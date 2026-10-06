"""Embedding CUDA tuning benchmark: one process per config, optional OOM handling."""
from __future__ import annotations

import argparse
import json
import statistics
import time
from pathlib import Path

import torch
from sentence_transformers import SentenceTransformer

BASE_DIR = Path(__file__).resolve().parent
MODEL_PATH = BASE_DIR / "models" / "bge-m3"


def percentile(values: list[float], p: float) -> float:
    ordered = sorted(values)
    idx = min(len(ordered) - 1, max(0, int(round((p / 100) * len(ordered))) - 1))
    return ordered[idx]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--max-seq", type=int, required=True)
    parser.add_argument("--batch", type=int, required=True)
    parser.add_argument("--runs", type=int, default=8)
    args = parser.parse_args()

    if not torch.cuda.is_available():
        raise SystemExit("CUDA unavailable")
    torch.cuda.empty_cache()
    free_before, total = torch.cuda.mem_get_info(0)
    model = SentenceTransformer(
        str(MODEL_PATH),
        device="cuda",
        model_kwargs={"torch_dtype": torch.float16},
        trust_remote_code=False,
    )
    model.max_seq_length = args.max_seq
    text = " ".join(["memory", "embedding", "retrieval"] * (args.max_seq // 3 + 1))
    texts = [text] * args.batch
    try:
        with torch.inference_mode():
            model.encode(texts, batch_size=args.batch, normalize_embeddings=True, show_progress_bar=False)
            torch.cuda.synchronize()
            torch.cuda.reset_peak_memory_stats()
            latencies: list[float] = []
            for _ in range(args.runs):
                start = time.perf_counter()
                model.encode(texts, batch_size=args.batch, normalize_embeddings=True, show_progress_bar=False)
                torch.cuda.synchronize()
                latencies.append((time.perf_counter() - start) * 1000)
        free_after, _ = torch.cuda.mem_get_info(0)
        result = {
            "max_seq": args.max_seq,
            "batch": args.batch,
            "runs": args.runs,
            "p50_ms": round(statistics.median(latencies), 2),
            "p95_ms": round(percentile(latencies, 95), 2),
            "peak_allocated_mb": round(torch.cuda.max_memory_allocated(0) / 1024 / 1024, 1),
            "peak_reserved_mb": round(torch.cuda.max_memory_reserved(0) / 1024 / 1024, 1),
            "free_before_mb": round(free_before / 1024 / 1024, 1),
            "free_after_mb": round(free_after / 1024 / 1024, 1),
            "total_mb": round(total / 1024 / 1024, 1),
        }
        print(json.dumps(result, ensure_ascii=False))
    except torch.cuda.OutOfMemoryError as exc:
        print(json.dumps({"max_seq": args.max_seq, "batch": args.batch, "oom": True, "error": str(exc).splitlines()[0]}, ensure_ascii=False))
        raise SystemExit(2)


if __name__ == "__main__":
    main()

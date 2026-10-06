"""BGE-M3 CUDA 冒烟：加载本地权重并验证 1024 维归一化向量。"""
from pathlib import Path

import torch
from sentence_transformers import SentenceTransformer

MODEL_PATH = Path(__file__).parent / "models" / "bge-m3"
MODEL_ID = "BAAI/bge-m3"
MAX_SEQ_LENGTH = 512


def main() -> None:
    if not torch.cuda.is_available():
        raise SystemExit("CUDA unavailable")
    model = SentenceTransformer(
        str(MODEL_PATH),
        device="cuda",
        model_kwargs={"torch_dtype": torch.float16},
        trust_remote_code=False,
    )
    model.max_seq_length = MAX_SEQ_LENGTH
    vectors = model.encode(
        ["hello embedding probe", "本地 CUDA embedding 探针"],
        batch_size=2,
        normalize_embeddings=True,
        convert_to_numpy=True,
        show_progress_bar=False,
    )
    print(f"model_id={MODEL_ID}")
    print(f"device={model.device}")
    print(f"dim={vectors.shape[1]}")
    print(f"count={vectors.shape[0]}")
    print(f"allocated_mb={torch.cuda.memory_allocated(0) / 1024 / 1024:.1f}")
    print(f"reserved_mb={torch.cuda.memory_reserved(0) / 1024 / 1024:.1f}")
    if vectors.shape[1] != 1024:
        raise SystemExit(f"unexpected dim: {vectors.shape[1]}")
    norms = (vectors**2).sum(axis=1) ** 0.5
    print(f"norms={','.join(f'{n:.4f}' for n in norms)}")


if __name__ == "__main__":
    main()

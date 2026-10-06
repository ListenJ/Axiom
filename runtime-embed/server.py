"""Axiom local CUDA embedding service (OpenAI-compatible)."""
from __future__ import annotations

import asyncio
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Protocol

import numpy as np
import torch
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from sentence_transformers import SentenceTransformer
from starlette.concurrency import run_in_threadpool

BASE_DIR = Path(__file__).resolve().parent
DEFAULT_MODEL_PATH = BASE_DIR / "models" / "bge-m3"


class Encoder(Protocol):
    model_id: str
    dim: int
    device: str
    max_seq_length: int
    gpu_name: str | None

    def encode(self, texts: list[str], batch_size: int, normalize_embeddings: bool) -> np.ndarray: ...
    def count_tokens(self, texts: list[str]) -> int: ...


class SentenceTransformerEncoder:
    def __init__(self, model_path: Path, device: str, max_seq_length: int) -> None:
        model_kwargs = {"torch_dtype": torch.float16} if device.startswith("cuda") else {}
        self._model = SentenceTransformer(
            str(model_path),
            device=device,
            model_kwargs=model_kwargs,
            trust_remote_code=False,
        )
        self._model.max_seq_length = max_seq_length
        self.model_id = os.environ.get("EMBED_MODEL_ID", "BAAI/bge-m3")
        get_dim = getattr(self._model, "get_embedding_dimension", None) or self._model.get_sentence_embedding_dimension
        self.dim = int(get_dim())
        self.device = str(self._model.device)
        self.max_seq_length = max_seq_length
        self.gpu_name = torch.cuda.get_device_name(0) if torch.cuda.is_available() else None

    def encode(self, texts: list[str], batch_size: int, normalize_embeddings: bool) -> np.ndarray:
        with torch.inference_mode():
            return self._model.encode(
                texts,
                batch_size=batch_size,
                normalize_embeddings=normalize_embeddings,
                convert_to_numpy=True,
                show_progress_bar=False,
            )

    def count_tokens(self, texts: list[str]) -> int:
        encoded = self._model.tokenizer(
            texts,
            truncation=True,
            max_length=self.max_seq_length,
            padding=False,
        )
        return sum(len(ids) for ids in encoded["input_ids"])


class EmbeddingRequest(BaseModel):
    model: str = "BAAI/bge-m3"
    input: str | list[str]
    encoding_format: str = Field(default="float", pattern="^float$")


def _normalize_inputs(raw: str | list[str], max_texts: int, max_chars: int) -> list[str]:
    texts = [raw] if isinstance(raw, str) else raw
    if not texts or any(not isinstance(t, str) or not t.strip() for t in texts):
        raise HTTPException(status_code=400, detail="input must contain non-empty strings")
    if len(texts) > max_texts:
        raise HTTPException(status_code=400, detail=f"too many inputs: {len(texts)} > {max_texts}")
    if sum(len(t) for t in texts) > max_chars:
        raise HTTPException(status_code=400, detail=f"input too large: exceeds {max_chars} chars")
    return texts


def create_app(encoder: Encoder) -> FastAPI:
    max_texts = int(os.environ.get("EMBED_MAX_TEXTS", "32"))
    max_chars = int(os.environ.get("EMBED_MAX_CHARS", "200000"))
    batch_size = int(os.environ.get("EMBED_BATCH_SIZE", "4"))
    max_concurrency = max(1, int(os.environ.get("EMBED_MAX_CONCURRENCY", "1")))
    semaphore = asyncio.Semaphore(max_concurrency)

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        yield

    app = FastAPI(title="Axiom Embedding Service", version="0.1.0", lifespan=lifespan)

    @app.get("/health")
    async def health() -> dict[str, object]:
        allocated = reserved = 0.0
        if torch.cuda.is_available():
            allocated = torch.cuda.memory_allocated(0) / 1024 / 1024
            reserved = torch.cuda.memory_reserved(0) / 1024 / 1024
        return {
            "status": "ok",
            "model": encoder.model_id,
            "dim": encoder.dim,
            "device": encoder.device,
            "gpu": encoder.gpu_name,
            "cuda_available": torch.cuda.is_available(),
            "max_seq_length": encoder.max_seq_length,
            "allocated_mb": round(allocated, 1),
            "reserved_mb": round(reserved, 1),
        }

    @app.get("/v1/models")
    async def models() -> dict[str, object]:
        return {
            "object": "list",
            "data": [{"id": encoder.model_id, "object": "model", "owned_by": "local"}],
        }

    @app.post("/v1/embeddings")
    async def embeddings(request: EmbeddingRequest) -> dict[str, object]:
        if request.model != encoder.model_id:
            raise HTTPException(status_code=400, detail=f"unknown model: {request.model}")
        texts = _normalize_inputs(request.input, max_texts, max_chars)
        async with semaphore:
            vectors = await run_in_threadpool(encoder.encode, texts, batch_size, True)
        if vectors.ndim != 2 or vectors.shape[0] != len(texts) or vectors.shape[1] != encoder.dim:
            raise HTTPException(status_code=500, detail="embedding dimension mismatch")
        data = [
            {"object": "embedding", "index": i, "embedding": vector.astype(float).tolist()}
            for i, vector in enumerate(vectors)
        ]
        total_tokens = encoder.count_tokens(texts)
        return {
            "object": "list",
            "data": data,
            "model": encoder.model_id,
            "usage": {"prompt_tokens": total_tokens, "total_tokens": total_tokens},
        }

    return app


def load_encoder() -> SentenceTransformerEncoder:
    model_path = Path(os.environ.get("EMBED_MODEL_PATH", str(DEFAULT_MODEL_PATH)))
    require_cuda = os.environ.get("EMBED_REQUIRE_CUDA", "1") == "1"
    allow_cpu = os.environ.get("EMBED_ALLOW_CPU", "0") == "1"
    if require_cuda and not torch.cuda.is_available():
        raise RuntimeError("CUDA unavailable and EMBED_REQUIRE_CUDA=1")
    if not torch.cuda.is_available() and not allow_cpu:
        raise RuntimeError("CUDA unavailable; set EMBED_ALLOW_CPU=1 to allow CPU fallback")
    device = os.environ.get("EMBED_DEVICE", "cuda" if torch.cuda.is_available() else "cpu")
    max_seq_length = int(os.environ.get("EMBED_MAX_SEQ_LENGTH", "2048"))
    print(
        f"[embed] loading model={model_path} device={device} max_seq_length={max_seq_length}",
        flush=True,
    )
    encoder = SentenceTransformerEncoder(model_path, device, max_seq_length)
    print(f"[embed] ready model={encoder.model_id} dim={encoder.dim} device={encoder.device}", flush=True)
    return encoder


app = create_app(load_encoder()) if os.environ.get("EMBED_SKIP_MODEL_LOAD") != "1" else None


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "server:app",
        host=os.environ.get("EMBED_HOST", "127.0.0.1"),
        port=int(os.environ.get("EMBED_PORT", "9001")),
        log_level="info",
    )

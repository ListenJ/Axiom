# BGE-M3 CUDA Benchmarks (RTX 3050 Ti Laptop 4GB)

Environment: `torch 2.14.1+cu130`, FP16, `sentence-transformers 6.1.0`, model `BAAI/bge-m3`.
Each configuration ran in an isolated process; latency is per `encode` call after warmup.

| max_seq | batch | p50 ms | p95 ms | peak allocated MB | peak reserved MB |
|---:|---:|---:|---:|---:|---:|
| 512 | 1 | 28.22 | 34.66 | 1102.2 | 1116.0 |
| 512 | 2 | 53.98 | 59.71 | 1113.2 | 1130.0 |
| 512 | 4 | 96.44 | 97.01 | 1135.2 | 1162.0 |
| 512 | 8 | 171.74 | 172.46 | 1179.2 | 1246.0 |
| 1024 | 1 | 57.10 | 83.45 | 1113.2 | 1130.0 |
| 1024 | 2 | 102.58 | 113.53 | 1135.2 | 1162.0 |
| 1024 | 4 | 183.63 | 185.02 | 1179.2 | 1246.0 |
| 2048 | 1 | 114.35 | 124.90 | 1135.2 | 1162.0 |
| 2048 | 2 | 207.13 | 208.58 | 1179.2 | 1246.0 |
| 2048 | 4 | 410.64 | 414.96 | 1267.3 | 1378.0 |
| 4096 | 1 | 253.12 | 254.87 | 1179.2 | 1246.0 |
| 4096 | 2 | 505.89 | 506.90 | 1267.3 | 1378.0 |

Selected defaults: `EMBED_MAX_SEQ_LENGTH=2048`, `EMBED_BATCH_SIZE=4`.
Reason: preserves the 4000-character Axiom embedding input window while keeping a 32-text chunk under the existing 5s edge timeout in normal short-text workloads; 4096 remains available as an explicit override.

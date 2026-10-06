"""CUDA 环境冒烟：必须在加载模型前确认 PyTorch 真正使用目标 GPU。"""
import torch


def main() -> None:
    print(f"torch={torch.__version__}")
    print(f"cuda_available={torch.cuda.is_available()}")
    if not torch.cuda.is_available():
        raise SystemExit("CUDA unavailable")
    print(f"cuda_version={torch.version.cuda}")
    print(f"device={torch.cuda.get_device_name(0)}")
    print(f"capability={torch.cuda.get_device_capability(0)}")
    x = torch.randn(512, 512, device="cuda", dtype=torch.float16)
    y = x @ x
    torch.cuda.synchronize()
    print(f"matmul_ok={tuple(y.shape)}")
    print(f"allocated_mb={torch.cuda.memory_allocated(0) / 1024 / 1024:.1f}")
    print(f"reserved_mb={torch.cuda.memory_reserved(0) / 1024 / 1024:.1f}")


if __name__ == "__main__":
    main()

"""PDF Worker — FastAPI service for MinerU PDF→Markdown conversion"""
import asyncio
import base64
import ipaddress
import json
import os
import socket
import time
import uuid
from pathlib import Path
from urllib.parse import urlparse

import httpx
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

app = FastAPI(title="Knowledge PDF Worker", version="0.1.0")

CACHE_DIR = Path.home() / "knowledge-cache"
CACHE_DIR.mkdir(parents=True, exist_ok=True)

tasks: dict[str, dict] = {}
MAX_CONCURRENT = int(os.environ.get("MAX_CONCURRENT", "2"))
semaphore = asyncio.Semaphore(MAX_CONCURRENT)

_MAX_DOWNLOAD_BYTES = int(os.environ.get("PDFWORKER_MAX_BYTES", str(50 * 1024 * 1024)))
_MAX_TASKS = 500
_BLOCKED_HOSTS = {"localhost", "metadata.google.internal", "169.254.169.254"}


def _is_private_url(url: str) -> bool:
    """True = 必须拒绝（私网/环回/链路本地/保留段/非 http(s)/解析失败）。"""
    try:
        p = urlparse(url)
        if p.scheme not in ("http", "https"):
            return True
        host = p.hostname or ""
        if host.lower() in _BLOCKED_HOSTS:
            return True
        for info in socket.getaddrinfo(host, None):
            ip = ipaddress.ip_address(info[4][0])
            if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast:
                return True
        return False
    except Exception:
        return True


class SubmitRequest(BaseModel):
    task_type: str
    payload: dict


class StatusResponse(BaseModel):
    task_id: str
    status: str
    progress: float = 0.0
    result: dict | None = None
    error: str | None = None


async def run_task(task_id: str, task_type: str, payload: dict):
    async with semaphore:
        try:
            tasks[task_id]["status"] = "running"
            tasks[task_id]["progress"] = 0.0

            if task_type == "url:fetch":
                url = payload["url"]
                if _is_private_url(url):
                    raise HTTPException(403, "blocked url")
                buf = bytearray()
                async with httpx.AsyncClient(timeout=30.0) as client:
                    async with client.stream("GET", url, headers={"User-Agent": "Mozilla/5.0"}) as resp:
                        resp.raise_for_status()
                        status_code = resp.status_code
                        async for chunk in resp.aiter_bytes():
                            buf.extend(chunk)
                            if len(buf) > _MAX_DOWNLOAD_BYTES:
                                raise HTTPException(413, "download too large")
                tasks[task_id]["result"] = {
                    "markdown": bytes(buf).decode("utf-8", errors="replace"),
                    "metadata": {"url": url, "status": status_code},
                }

            elif task_type == "pdf:download":
                url = payload["url"]
                if _is_private_url(url):
                    raise HTTPException(403, "blocked url")
                dest = CACHE_DIR / task_id / "input.pdf"
                dest.parent.mkdir(parents=True, exist_ok=True)
                proxy_url = os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy") or None
                buf = bytearray()
                async with httpx.AsyncClient(timeout=120.0, follow_redirects=True, proxy=proxy_url) as client:
                    async with client.stream("GET", url, headers={"User-Agent": "Mozilla/5.0"}) as resp:
                        resp.raise_for_status()
                        async for chunk in resp.aiter_bytes():
                            buf.extend(chunk)
                            if len(buf) > _MAX_DOWNLOAD_BYTES:
                                raise HTTPException(413, "download too large")
                dest.write_bytes(bytes(buf))
                tasks[task_id]["result"] = {
                    "file_path": str(dest),
                    "metadata": {"url": url, "size_bytes": len(buf)},
                }

            elif task_type == "pdf:convert" or task_type == "pdf:text":
                proxy_url = os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy") or None
                dest_dir = CACHE_DIR / task_id
                dest_dir.mkdir(parents=True, exist_ok=True)

                pdf_path = dest_dir / "input.pdf"
                tasks[task_id]["progress"] = 0.1
                # 审计 F-2（2026-08-24）：支持 data_base64 内联上传（本地文件场景），
                # 与 url 二选一；此前无条件读 payload["url"] 使本地文件任务必失败。
                data_b64 = payload.get("data_base64")
                url = payload.get("url")
                if data_b64:
                    if len(data_b64) * 3 // 4 > _MAX_DOWNLOAD_BYTES:
                        raise HTTPException(413, "payload too large")
                    pdf_path.write_bytes(base64.b64decode(data_b64))
                    src_meta = {"source": payload.get("name", "inline")}
                elif url:
                    if _is_private_url(url):
                        raise HTTPException(403, "blocked url")
                    buf = bytearray()
                    async with httpx.AsyncClient(timeout=120.0, follow_redirects=True, proxy=proxy_url) as client:
                        async with client.stream("GET", url, headers={"User-Agent": "Mozilla/5.0"}) as resp:
                            resp.raise_for_status()
                            async for chunk in resp.aiter_bytes():
                                buf.extend(chunk)
                                if len(buf) > _MAX_DOWNLOAD_BYTES:
                                    raise HTTPException(413, "download too large")
                    pdf_path.write_bytes(bytes(buf))
                    src_meta = {"url": url}
                else:
                    raise KeyError("payload requires 'url' or 'data_base64'")
                tasks[task_id]["progress"] = 0.3

                markdown = ""
                try:
                    import fitz
                    doc = fitz.open(pdf_path)
                    pages = []
                    for page_num in range(len(doc)):
                        page = doc[page_num]
                        text = page.get_text().strip()
                        if not text:
                            continue  # 跳过空页，避免噪声页头
                        pages.append(f"## Page {page_num + 1}\n\n{text}")
                    markdown = "\n\n".join(pages)
                    if not markdown.strip():
                        tasks[task_id]["status"] = "failed"
                        tasks[task_id]["error"] = "no extractable text"
                    else:
                        tasks[task_id]["result"] = {
                            "markdown": markdown,
                            "metadata": {**src_meta, "pages": len(pages)},
                            "file_path": str(pdf_path),
                        }
                    doc.close()
                    tasks[task_id]["progress"] = 0.7
                except ImportError:
                    output_dir = dest_dir / "mineru_output"
                    output_dir.mkdir(exist_ok=True)
                    cmd = ["mineru", "--cpu=true", "--pdf", str(pdf_path), "--output-dir", str(output_dir)]
                    proc = await asyncio.create_subprocess_exec(
                        *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
                    )
                    stdout, stderr = await proc.communicate()
                    if proc.returncode != 0:
                        raise RuntimeError(f"MinerU failed (exit={proc.returncode}): {stderr.decode()[:500]}")
                    tasks[task_id]["progress"] = 0.7
                    md_files = list(output_dir.glob("**/*.md"))
                    for mf in md_files[:1]:
                        markdown = mf.read_text(encoding="utf-8")
                    tasks[task_id]["result"] = {
                        "markdown": markdown,
                        "metadata": {**src_meta, "pages": len(md_files)},
                        "file_path": str(output_dir),
                    }

            if tasks[task_id].get("status") != "failed":
                tasks[task_id]["status"] = "completed"
            tasks[task_id]["progress"] = 1.0

        except Exception as e:
            tasks[task_id]["status"] = "failed"
            tasks[task_id]["error"] = str(e)


@app.post("/v1/submit")
async def submit(req: SubmitRequest):
    while len(tasks) >= _MAX_TASKS:
        for old_id, old in list(tasks.items()):
            if old["status"] in ("completed", "failed"):
                del tasks[old_id]
                break
        else:
            break
    task_id = str(uuid.uuid4())
    tasks[task_id] = {"status": "queued", "progress": 0.0}
    asyncio.create_task(run_task(task_id, req.task_type, req.payload))
    return {"task_id": task_id, "status": "queued"}


@app.get("/v1/status/{task_id}")
async def get_status(task_id: str):
    task = tasks.get(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    return StatusResponse(task_id=task_id, **task)


@app.get("/health")
async def health():
    active = sum(1 for t in tasks.values() if t["status"] == "running")
    return {"status": "ok", "active_tasks": active, "cache_dir": str(CACHE_DIR)}

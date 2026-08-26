"""PDF Worker — FastAPI service for MinerU PDF→Markdown conversion"""
import asyncio
import json
import os
import time
import uuid
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

app = FastAPI(title="Knowledge PDF Worker", version="0.1.0")

CACHE_DIR = Path.home() / "knowledge-cache"
CACHE_DIR.mkdir(parents=True, exist_ok=True)

tasks: dict[str, dict] = {}
MAX_CONCURRENT = int(os.environ.get("MAX_CONCURRENT", "2"))
semaphore = asyncio.Semaphore(MAX_CONCURRENT)


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
                async with httpx.AsyncClient(timeout=30.0) as client:
                    resp = await client.get(url, headers={"User-Agent": "Mozilla/5.0"})
                    resp.raise_for_status()
                    tasks[task_id]["result"] = {
                        "markdown": resp.text,
                        "metadata": {"url": url, "status": resp.status_code},
                    }

            elif task_type == "pdf:download":
                url = payload["url"]
                dest = CACHE_DIR / task_id / "input.pdf"
                dest.parent.mkdir(parents=True, exist_ok=True)
                proxy_url = os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy") or None
                async with httpx.AsyncClient(timeout=120.0, follow_redirects=True, proxy=proxy_url) as client:
                    resp = await client.get(url, headers={"User-Agent": "Mozilla/5.0"})
                    resp.raise_for_status()
                    dest.write_bytes(resp.content)
                tasks[task_id]["result"] = {
                    "file_path": str(dest),
                    "metadata": {"url": url, "size_bytes": len(resp.content)},
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
                    import base64 as _base64
                    pdf_path.write_bytes(_base64.b64decode(data_b64))
                    src_meta = {"source": payload.get("name", "inline")}
                elif url:
                    async with httpx.AsyncClient(timeout=120.0, follow_redirects=True, proxy=proxy_url) as client:
                        resp = await client.get(url, headers={"User-Agent": "Mozilla/5.0"})
                        resp.raise_for_status()
                        pdf_path.write_bytes(resp.content)
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
                            continue
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
                except ImportError:
                    output_dir = dest_dir / "mineru_output"
                    output_dir.mkdir(exist_ok=True)
                    cmd = f"mineru --cpu=true --pdf {pdf_path} --output-dir {output_dir}"
                    proc = await asyncio.create_subprocess_shell(
                        cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
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

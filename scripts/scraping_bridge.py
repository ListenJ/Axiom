#!/usr/bin/env python3
"""
Scrapling 桥接脚本
Bun 侧通过 stdin/stdout JSON 交换数据，调用 Scrapling 的三种 Fetcher

依赖安装:
    pip install scrapling

使用方式:
    python3 scripts/scraping_bridge.py <url> <mode> <output_format> [--selector <css>]
"""
import sys
import json
import argparse


def main():
    parser = argparse.ArgumentParser(description="Scrapling bridge for Axiom")
    parser.add_argument("url", help="Target URL")
    parser.add_argument("mode", choices=["get", "fetch", "stealthy"], help="Fetcher mode")
    parser.add_argument("output_format", choices=["markdown", "html", "text", "json"], help="Output format")
    parser.add_argument("--selector", default="", help="CSS selector for content extraction")
    args = parser.parse_args()

    result = scrape(args.url, args.mode, args.output_format, args.selector)
    print(json.dumps(result, ensure_ascii=False))


def scrape(url: str, mode: str, output_format: str, selector: str) -> dict:
    try:
        from scrapling import Fetcher, DynamicFetcher, StealthyFetcher
    except ImportError:
        return {
            "success": False,
            "url": url,
            "title": "",
            "content": "",
            "metadata": {},
            "error": "scrapling not installed. Run: pip install scrapling",
        }

    try:
        if mode == "get":
            page = Fetcher().get(url)
        elif mode == "fetch":
            page = DynamicFetcher().fetch(url)
        elif mode == "stealthy":
            page = StealthyFetcher().fetch(url)
        else:
            raise ValueError(f"Unknown mode: {mode}")

        title = page.title or "Untitled"

        # 内容提取
        if selector:
            elements = page.css(selector)
            content = "\n".join(el.text for el in elements)
        else:
            content = page.text or ""

        # 格式转换
        if output_format == "markdown":
            content = html_to_markdown(page.html or content)
        elif output_format == "text":
            content = strip_html(content)
        elif output_format == "json":
            content = json.dumps({"title": title, "text": content}, ensure_ascii=False)

        return {
            "success": True,
            "url": url,
            "title": title,
            "content": content,
            "metadata": {
                "mode": mode,
                "selector": selector or None,
                "links": len(page.links) if hasattr(page, "links") else 0,
            },
        }
    except Exception as e:
        return {
            "success": False,
            "url": url,
            "title": "",
            "content": "",
            "metadata": {},
            "error": str(e),
        }


def html_to_markdown(html: str) -> str:
    """简易 HTML → Markdown 转换"""
    import re
    text = html
    # 标题
    text = re.sub(r"<h1[^>]*>(.*?)</h1>", r"# \1\n", text, flags=re.S)
    text = re.sub(r"<h2[^>]*>(.*?)</h2>", r"## \1\n", text, flags=re.S)
    text = re.sub(r"<h3[^>]*>(.*?)</h3>", r"### \1\n", text, flags=re.S)
    # 粗体/斜体
    text = re.sub(r"<(strong|b)[^>]*>(.*?)</\1>", r"**\2**", text, flags=re.S)
    text = re.sub(r"<(em|i)[^>]*>(.*?)</\1>", r"*\2*", text, flags=re.S)
    # 链接
    text = re.sub(r'<a[^>]+href="([^"]+)"[^>]*>(.*?)</a>', r"[\2](\1)", text, flags=re.S)
    # 代码块
    text = re.sub(r"<pre[^>]*><code[^>]*>(.*?)</code></pre>", r"```\n\1\n```", text, flags=re.S)
    text = re.sub(r"<code[^>]*>(.*?)</code>", r"`\1`", text, flags=re.S)
    # 列表
    text = re.sub(r"<li[^>]*>(.*?)</li>", r"- \1\n", text, flags=re.S)
    # 段落
    text = re.sub(r"<p[^>]*>(.*?)</p>", r"\1\n\n", text, flags=re.S)
    # 移除剩余标签
    text = re.sub(r"<[^>]+>", "", text)
    # 清理空白
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def strip_html(html: str) -> str:
    import re
    text = re.sub(r"<[^>]+>", "\n", html)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


if __name__ == "__main__":
    main()

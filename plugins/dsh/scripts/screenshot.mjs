#!/usr/bin/env node
/**
 * axiom-dsh 磨砂主题截图脚本
 * 用法: node scripts/screenshot.mjs [url] [out]
 * 默认: file://<repo>/plugins/dsh/preview/frosted-preview.html
 * 如果要截 DSH: node scripts/screenshot.mjs http://127.0.0.1:3080 dsh-main.png
 */
import { chromium } from 'playwright'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..', '..', '..')
const previewUrl = `file:///${path.join(repoRoot, 'plugins', 'dsh', 'preview', 'frosted-preview.html').replace(/\\/g, '/')}`
const url = process.argv[2] || previewUrl
const outName = process.argv[3] || (url.startsWith('file') ? 'frosted-preview.png' : 'dsh-main.png')
const outDir = path.join(__dirname, '..', 'preview', 'screenshots')
fs.mkdirSync(outDir, { recursive: true })
const outPath = path.join(outDir, outName)

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })
try {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 })
  // 等待背景/动画稳定
  await page.waitForTimeout(600)
  await page.screenshot({ path: outPath, fullPage: true })
  console.log(JSON.stringify({ ok: true, url, outPath }))
} catch (err) {
  console.error(`截图失败: ${err.message}`)
  process.exit(1)
} finally {
  await browser.close()
}
import { useEffect, useState } from 'react'
import { ScanText, Upload, FileText, Download, Loader2, AlertCircle } from 'lucide-react'
import ShimmerCard from '@/components/ui/ShimmerCard'
import { useApp } from '@/state/useApp'
import { endpoints } from '@/lib/api'

interface OcrStatus {
  ready: boolean
  languages: string[]
  version?: string
}

export default function OCR() {
  const [status, setStatus] = useState<OcrStatus | null>(null)
  const [path, setPath] = useState('')
  const [languages, setLanguages] = useState<string[]>(['eng'])
  const [scanning, setScanning] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const toast = useApp((s) => s.toast)

  useEffect(() => {
    endpoints.ocr
      .status()
      .then((d) => {
        const s = d as Partial<OcrStatus>
        setStatus({ ready: Boolean(s.ready), languages: s.languages ?? ['eng'] })
        if (s.languages?.length) setLanguages(s.languages)
      })
      .catch((e) => setError(String((e as Error)?.message ?? e)))
  }, [])

  const handleScan = async () => {
    if (!path.trim()) {
      toast('请输入文件路径', 'warning')
      return
    }
    setScanning(true)
    setError(null)
    setResult(null)
    try {
      const res = await endpoints.ocr.scan({ path: path.trim(), languages })
      const text = typeof res === 'string' ? res : JSON.stringify(res, null, 2)
      setResult(text)
      toast('扫描完成', 'success')
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e)
      setError(msg)
      toast('扫描失败：' + msg, 'error')
    } finally {
      setScanning(false)
    }
  }

  const handleExport = async (format: 'md' | 'txt' | 'json') => {
    if (!result) return
    try {
      const res = await endpoints.ocr.export({ path: path.trim(), format })
      const text = typeof res === 'string' ? res : JSON.stringify(res, null, 2)
      const blob = new Blob([text], { type: 'text/plain' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${path.split(/[/\\]/).pop()?.replace(/\.[^.]+$/, '') ?? 'ocr'}.${format}`
      a.click()
      URL.revokeObjectURL(url)
      toast('导出成功', 'success')
    } catch (e) {
      toast('导出失败：' + ((e as Error)?.message ?? String(e)), 'error')
    }
  }

  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
          <ScanText className="size-6 text-accent" />
          文字识别
        </h1>
        <p className="text-text-secondary">OCR 文档扫描、识别与导出。</p>
      </header>

      {status && (
        <div
          className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-sm ${
            status.ready
              ? 'border-success/30 bg-success/10 text-success'
              : 'border-warning/30 bg-warning/10 text-warning'
          }`}
        >
          <span className={`size-2 rounded-full ${status.ready ? 'bg-success' : 'bg-warning'}`} />
          OCR 引擎 {status.ready ? '就绪' : '未就绪'} · 支持 {status.languages.length} 种语言
        </div>
      )}

      {error && (
        <p role="alert" className="flex items-center gap-2 text-sm text-danger">
          <AlertCircle className="size-4" />
          {error}
        </p>
      )}

      <ShimmerCard>
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <Upload className="size-4 text-accent" />
          扫描文档
        </h2>
        <div className="mt-3 space-y-3">
          <div>
            <label htmlFor="ocr-path" className="text-sm text-text-secondary">
              文件路径
            </label>
            <input
              id="ocr-path"
              type="text"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="/path/to/image.png 或 C:\path\to\doc.pdf"
              className="mt-1 w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text placeholder:text-text-muted focus:border-accent focus:outline-none"
            />
          </div>
          <div>
            <label className="text-sm text-text-secondary">识别语言（逗号分隔）</label>
            <input
              type="text"
              value={languages.join(',')}
              onChange={(e) =>
                setLanguages(e.target.value.split(',').map((s) => s.trim()).filter(Boolean))
              }
              placeholder="eng, chi_sim"
              className="mt-1 w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text placeholder:text-text-muted focus:border-accent focus:outline-none"
            />
          </div>
          <button
            type="button"
            onClick={handleScan}
            disabled={scanning || !path.trim()}
            className="focus-ring flex h-10 items-center gap-2 rounded-xl bg-accent px-4 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            {scanning ? <Loader2 className="size-4 animate-spin" /> : <ScanText className="size-4" />}
            {scanning ? '扫描中…' : '开始扫描'}
          </button>
        </div>
      </ShimmerCard>

      {result && (
        <ShimmerCard>
          <div className="flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-base font-semibold">
              <FileText className="size-4 text-accent" />
              识别结果
            </h2>
            <div className="flex gap-1">
              {(['md', 'txt', 'json'] as const).map((fmt) => (
                <button
                  key={fmt}
                  type="button"
                  onClick={() => handleExport(fmt)}
                  className="focus-ring flex h-8 items-center gap-1 rounded-lg border border-border bg-bg-secondary px-2.5 text-xs text-text-secondary transition-colors hover:bg-surface-hover hover:text-text"
                >
                  <Download className="size-3" />
                  {fmt.toUpperCase()}
                </button>
              ))}
            </div>
          </div>
          <pre className="mt-3 max-h-96 overflow-y-auto whitespace-pre-wrap rounded-xl border border-border bg-bg p-3 text-xs text-text-secondary">
            {result}
          </pre>
        </ShimmerCard>
      )}
    </div>
  )
}

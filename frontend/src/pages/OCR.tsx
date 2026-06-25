import { useEffect, useState } from 'react'
import { ScanText, Upload, FileText, Download, AlertCircle, CheckCircle2 } from 'lucide-react'
import {
  ShimmerCard,
  Button,
  PageHeader,
  Input,
  LoadingDots,
} from '@/components/ui'
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
    <div className="space-y-6 fade-in">
      <PageHeader
        icon={<ScanText className="size-5" />}
        title="文字识别"
        description="OCR 文档扫描、识别与导出。"
      />

      {status && (
        <div
          role="status"
          aria-label={`OCR ${status.ready ? '就绪' : '未就绪'}`}
          className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-sm ${
            status.ready
              ? 'border-[var(--success-soft)] bg-[var(--success-soft)] text-[var(--success)]'
              : 'border-[var(--warning-soft)] bg-[var(--warning-soft)] text-[var(--warning)]'
          }`}
        >
          {status.ready ? (
            <CheckCircle2 className="size-4" />
          ) : (
            <AlertCircle className="size-4" />
          )}
          <span>
            OCR {status.ready ? '就绪' : '未就绪'}
          </span>
        </div>
      )}

      {error && (
        <p
          role="alert"
          className="flex items-center gap-2 rounded-lg border border-[var(--danger-soft)] bg-[var(--danger-soft)] px-3 py-2 text-sm text-[var(--danger)]"
        >
          <AlertCircle className="size-4" />
          {error}
        </p>
      )}

      <ShimmerCard>
        <h2 className="mb-3 flex items-center gap-2 text-base font-semibold text-[var(--text)]">
          <Upload className="size-4 text-[var(--accent)]" />
          扫描文档
        </h2>
        <div className="space-y-3">
          <Input
            id="ocr-path"
            label="文件路径"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="/path/to/image.png"
          />
          <Input
            id="ocr-languages"
            label="识别语言（逗号分隔）"
            value={languages.join(',')}
            onChange={(e) =>
              setLanguages(e.target.value.split(',').map((s) => s.trim()).filter(Boolean))
            }
            placeholder="eng, chi_sim"
          />
          <Button
            onClick={handleScan}
            loading={scanning}
            disabled={!path.trim()}
            icon={<ScanText className="size-4" />}
          >
            {scanning ? '扫描中…' : '开始扫描'}
          </Button>
          {scanning && (
            <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
              <LoadingDots size="sm" />
              正在处理图像…
            </div>
          )}
        </div>
      </ShimmerCard>

      {result && (
        <ShimmerCard>
          <div className="flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-base font-semibold text-[var(--text)]">
              <FileText className="size-4 text-[var(--accent)]" />
              识别结果
            </h2>
            <div className="flex gap-1">
              {(['md', 'txt', 'json'] as const).map((fmt) => (
                <Button
                  key={fmt}
                  size="sm"
                  variant="secondary"
                  onClick={() => handleExport(fmt)}
                  icon={<Download className="size-3" />}
                >
                  {fmt.toUpperCase()}
                </Button>
              ))}
            </div>
          </div>
          <pre className="mt-3 max-h-96 overflow-y-auto whitespace-pre-wrap rounded-xl border border-[var(--border)] bg-[var(--bg)] p-3 text-xs text-[var(--text-secondary)]">
            {result}
          </pre>
        </ShimmerCard>
      )}
    </div>
  )
}

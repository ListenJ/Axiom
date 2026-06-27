import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Opening Animation — Wireframe draw + radial fill.
 *
 * Phase 1 (0-1.2s): SVG lines draw out the layout wireframe
 * Phase 2 (1.2-2.0s): Radial fill expands from center
 * Phase 3 (2.0-2.5s): Overlay fades out
 */
export default function OpeningAnimation({ onComplete }: { onComplete: () => void }) {
  const svgRef = useRef<SVGSVGElement>(null)
  const [phase, setPhase] = useState<'draw' | 'fill' | 'fade' | 'done'>('draw')

  // Initialize stroke-dasharray on mount
  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const paths = svg.querySelectorAll<SVGPathElement>('[data-draw]')
    paths.forEach((p) => {
      const len = p.getTotalLength()
      p.style.strokeDasharray = `${len}`
      p.style.strokeDashoffset = `${len}`
    })
  }, [])

  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = []
    timers.push(setTimeout(() => setPhase('fill'), 1200))
    timers.push(setTimeout(() => setPhase('fade'), 2000))
    timers.push(setTimeout(() => {
      setPhase('done')
      onComplete()
    }, 2500))
    return () => timers.forEach(clearTimeout)
  }, [onComplete])

  if (phase === 'done') return null

  const drawClass = 'stroke-[var(--accent)] fill-none'
  const lineClass = 'stroke-[var(--border-strong)] fill-none'
  const subtleClass = 'stroke-[var(--border)] fill-none'

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-[var(--bg)]"
      style={{ opacity: phase === 'fade' ? 0 : 1, transition: 'opacity 0.5s ease-out' }}
    >
      <svg
        ref={svgRef}
        viewBox="0 0 800 500"
        className="h-[80vh] w-[90vw] max-w-[1200px]"
        fill="none"
      >
        {/* ── Sidebar frame ── */}
        <path
          data-draw d="M20 32 Q20 20 32 20 L188 20 Q200 20 200 32 L200 468 Q200 480 188 480 L32 480 Q20 480 20 468 Z"
          className={drawClass} strokeWidth="1.5"
          style={{ animation: 'drawLine 0.9s ease-out forwards', animationDelay: '0s' }}
        />

        {/* Sidebar nav items */}
        {[60, 100, 140, 180, 220].map((y, i) => (
          <path
            key={`si${i}`}
            data-draw d={`M40 ${y} L170 ${y}`}
            className={lineClass} strokeWidth="1"
            style={{ animation: 'drawLine 0.4s ease-out forwards', animationDelay: `${0.15 + i * 0.07}s` }}
          />
        ))}

        {/* Sidebar active item */}
        <path
          data-draw d="M28 52 Q28 44 36 44 L184 44 Q192 44 192 52 L192 80 Q192 88 184 88 L36 88 Q28 88 28 80 Z"
          className="stroke-[var(--accent)] fill-none" strokeWidth="1" opacity="0.4"
          style={{ animation: 'drawLine 0.5s ease-out forwards', animationDelay: '0.45s' }}
        />

        {/* ── Header frame ── */}
        <path
          data-draw d="M220 32 Q220 20 232 20 L768 20 Q780 20 780 32 L780 64 Q780 76 768 76 L232 76 Q220 76 220 64 Z"
          className={drawClass} strokeWidth="1.5"
          style={{ animation: 'drawLine 0.7s ease-out forwards', animationDelay: '0.12s' }}
        />

        {/* Header search */}
        <path
          data-draw d="M240 36 Q240 30 246 30 L540 30 Q546 30 546 36 L546 60 Q546 66 540 66 L246 66 Q240 66 240 60 Z"
          className={lineClass} strokeWidth="0.8"
          style={{ animation: 'drawLine 0.4s ease-out forwards', animationDelay: '0.5s' }}
        />

        {/* Header icons */}
        {[568, 604, 640, 676].map((x, i) => (
          <circle
            key={`hi${i}`}
            data-draw cx={x} cy="48" r="10"
            className={lineClass} strokeWidth="0.8"
            style={{ animation: 'drawLine 0.3s ease-out forwards', animationDelay: `${0.58 + i * 0.05}s` }}
          />
        ))}

        {/* ── Content area ── */}
        <path
          data-draw d="M220 96 Q220 84 232 84 L768 84 Q780 84 780 96 L780 468 Q780 480 768 480 L232 480 Q220 480 220 468 Z"
          className={drawClass} strokeWidth="1.5"
          style={{ animation: 'drawLine 0.8s ease-out forwards', animationDelay: '0.25s' }}
        />

        {/* Title */}
        <path
          data-draw d="M248 116 L448 116 L448 136 L248 136 Z"
          className={lineClass} strokeWidth="0.8"
          style={{ animation: 'drawLine 0.35s ease-out forwards', animationDelay: '0.65s' }}
        />
        {/* Subtitle */}
        <path
          data-draw d="M248 148 L568 148"
          className={subtleClass} strokeWidth="0.6"
          style={{ animation: 'drawLine 0.3s ease-out forwards', animationDelay: '0.72s' }}
        />

        {/* Card row */}
        {[0, 1, 2].map((i) => {
          const x = 248 + i * 176
          return (
            <path
              key={`cr${i}`}
              data-draw
              d={`M${x} 186 Q${x} 176 ${x + 10} 176 L${x + 142} 176 Q${x + 152} 176 ${x + 152} 186 L${x + 152} 278 Q${x + 152} 288 ${x + 142} 288 L${x + 10} 288 Q${x} 288 ${x} 278 Z`}
              className={lineClass} strokeWidth="0.8"
              style={{ animation: 'drawLine 0.5s ease-out forwards', animationDelay: `${0.8 + i * 0.1}s` }}
            />
          )
        })}

        {/* Card inner lines */}
        {[0, 1, 2].map((i) => {
          const x = 248 + i * 176
          return (
            <g key={`ci${i}`}>
              <path
                data-draw d={`M${x + 16} 212 L${x + 100} 212`}
                className={subtleClass} strokeWidth="0.6"
                style={{ animation: 'drawLine 0.2s ease-out forwards', animationDelay: `${1.0 + i * 0.06}s` }}
              />
              <path
                data-draw d={`M${x + 16} 236 L${x + 136} 236`}
                className={subtleClass} strokeWidth="0.5"
                style={{ animation: 'drawLine 0.2s ease-out forwards', animationDelay: `${1.05 + i * 0.06}s` }}
              />
              <path
                data-draw d={`M${x + 16} 256 L${x + 80} 256`}
                className={subtleClass} strokeWidth="0.5"
                style={{ animation: 'drawLine 0.2s ease-out forwards', animationDelay: `${1.1 + i * 0.06}s` }}
              />
            </g>
          )
        })}

        {/* Large content block */}
        <path
          data-draw
          d="M248 306 Q248 296 258 296 L732 296 Q742 296 742 306 L742 454 Q742 464 732 464 L258 464 Q248 464 248 454 Z"
          className={lineClass} strokeWidth="0.8"
          style={{ animation: 'drawLine 0.6s ease-out forwards', animationDelay: '1.1s' }}
        />

        {/* Content lines */}
        {[330, 354, 378, 402, 426].map((y, i) => (
          <path
            key={`cl${i}`}
            data-draw d={`M272 ${y} L${272 + (440 - i * 55)} ${y}`}
            className={subtleClass} strokeWidth="0.5"
            style={{ animation: 'drawLine 0.25s ease-out forwards', animationDelay: `${1.18 + i * 0.04}s` }}
          />
        ))}
      </svg>

      {/* Radial fill */}
      {phase !== 'draw' && (
        <div
          className="absolute inset-0 bg-[var(--bg)]"
          style={{
            animation: 'radialWipe 0.8s cubic-bezier(0.4, 0, 0.2, 1) forwards',
          }}
        />
      )}

      {/* Brand */}
      <div
        className="absolute flex flex-col items-center gap-3"
        style={{
          opacity: phase === 'fill' ? 1 : 0,
          transform: phase === 'fill' ? 'scale(1)' : 'scale(0.8)',
          transition: 'all 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
        }}
      >
        <div
          className="flex h-14 w-14 items-center justify-center rounded-2xl text-xl font-bold text-white shadow-2xl"
          style={{ background: 'linear-gradient(135deg, var(--accent), var(--accent-active))' }}
        >
          OC
        </div>
        <span className="font-display text-base font-semibold tracking-tight text-[var(--text)]">
          OpenClaw
        </span>
      </div>

      <style>{`
        @keyframes drawLine {
          to { stroke-dashoffset: 0; }
        }
        @keyframes radialWipe {
          from { clip-path: circle(0% at 50% 50%); }
          to   { clip-path: circle(100% at 50% 50%); }
        }
      `}</style>
    </div>
  )
}

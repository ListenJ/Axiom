import { create } from 'zustand'

export type MotionLevel = 'system' | 'reduced' | 'off'

interface MotionPrefsState {
  /** system=跟随系统；reduced=强制减少；off=关闭全部动效 */
  level: MotionLevel
  setLevel: (level: MotionLevel) => void
}

const MOTION_KEY = 'axiom:motion'

export function parseMotionLevel(value: string | null): MotionLevel {
  return value === 'reduced' || value === 'off' ? value : 'system'
}

function readLevel(): MotionLevel {
  if (typeof localStorage === 'undefined') return 'system'
  return parseMotionLevel(localStorage.getItem(MOTION_KEY))
}

export const useMotionPrefs = create<MotionPrefsState>((set) => ({
  level: readLevel(),
  setLevel: (level) => {
    if (typeof localStorage !== 'undefined') localStorage.setItem(MOTION_KEY, level)
    set({ level })
  },
}))

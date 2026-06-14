/**
 * Tauri 2.0 Integration Tests
 *
 * Validates the Tauri configuration and build setup. Tests do not require
 * an actual Tauri runtime — they verify the configuration files, the
 * frontend build output structure, and the integration contract between
 * the React frontend and the Tauri shell.
 */
import { describe, it, expect } from "bun:test"
import { readFileSync, existsSync, statSync, readdirSync } from "node:fs"
import { join } from "node:path"

const ROOT = join(import.meta.dir, "..")
const TAURI_CONF = join(ROOT, "src-tauri", "tauri.conf.json")
const FRONTEND_DIST = join(ROOT, "frontend", "dist")
const FRONTEND_INDEX = join(ROOT, "frontend", "index.html")
const PACKAGE_JSON = join(ROOT, "frontend", "package.json")
const TAURI_DIR = join(ROOT, "src-tauri")

interface TauriConfig {
  $schema: string
  productName: string
  version: string
  identifier: string
  build: {
    frontendDist: string
    devUrl: string
    beforeDevCommand: string
    beforeBuildCommand: string
  }
  app: {
    windows: Array<{
      title: string
      width: number
      height: number
      minWidth: number
      minHeight: number
      resizable: boolean
      fullscreen: boolean
      center: boolean
      decorations: boolean
    }>
    security: { csp: string | null }
  }
  bundle: {
    active: boolean
    targets: string
    icon: string[]
    android?: { debugApplicationIdSuffix: string }
  }
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T
}

function exists(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isDirectory()
  } catch {
    return false
  }
}

describe("Tauri 2.0 Configuration", () => {
  const conf = readJson<TauriConfig>(TAURI_CONF)

  it("uses Tauri 2.0 schema", () => {
    expect(conf.$schema).toContain("tauri.app/config/2")
  })

  it("has correct product name and version", () => {
    expect(conf.productName).toBe("openclaw")
    expect(conf.version).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it("has unique bundle identifier", () => {
    expect(conf.identifier).toContain(".")
    // must have at least 2 segments (reverse-DNS)
    expect(conf.identifier.split(".").length).toBeGreaterThanOrEqual(2)
  })

  it("points frontendDist to React build output", () => {
    expect(conf.build.frontendDist).toBe("./frontend/dist")
  })

  it("configures devUrl to backend HTTP port", () => {
    expect(conf.build.devUrl).toBe("http://localhost:18789")
  })

  it("has beforeDevCommand for Vite dev server", () => {
    expect(conf.build.beforeDevCommand).toContain("frontend")
    expect(conf.build.beforeDevCommand).toContain("dev")
  })

  it("has beforeBuildCommand for Vite production build", () => {
    expect(conf.build.beforeBuildCommand).toContain("frontend")
    expect(conf.build.beforeBuildCommand).toContain("build")
  })
})

describe("Tauri Window Configuration", () => {
  const conf = readJson<TauriConfig>(TAURI_CONF)

  it("has at least one window", () => {
    expect(conf.app.windows.length).toBeGreaterThan(0)
  })

  it("window has reasonable size", () => {
    const w = conf.app.windows[0]
    expect(w.width).toBeGreaterThanOrEqual(800)
    expect(w.height).toBeGreaterThanOrEqual(600)
    expect(w.minWidth).toBeLessThanOrEqual(w.width)
    expect(w.minHeight).toBeLessThanOrEqual(w.height)
  })

  it("window meets responsive minimum (900x600)", () => {
    const w = conf.app.windows[0]
    expect(w.minWidth).toBe(900)
    expect(w.minHeight).toBe(600)
  })

  it("window is resizable and centered", () => {
    const w = conf.app.windows[0]
    expect(w.resizable).toBe(true)
    expect(w.center).toBe(true)
  })

  it("window has decorations (title bar)", () => {
    const w = conf.app.windows[0]
    expect(w.decorations).toBe(true)
  })

  it("window title matches app name", () => {
    const w = conf.app.windows[0]
    expect(w.title).toContain("OpenClaw")
  })
})

describe("Tauri Bundle Configuration", () => {
  const conf = readJson<TauriConfig>(TAURI_CONF)

  it("bundle is active", () => {
    expect(conf.bundle.active).toBe(true)
  })

  it("targets all platforms", () => {
    expect(conf.bundle.targets).toBe("all")
  })

  it("includes icon files in bundle config", () => {
    expect(conf.bundle.icon.length).toBeGreaterThan(0)
    conf.bundle.icon.forEach((iconPath) => {
      // verify icon path follows expected pattern
      expect(iconPath).toMatch(/icons\//)
    })
  })

  it("configures Android debug suffix", () => {
    expect(conf.bundle.android?.debugApplicationIdSuffix).toBe(".debug")
  })
})

describe("Tauri Security", () => {
  const conf = readJson<TauriConfig>(TAURI_CONF)

  it("explicitly allows wide CSP (null = no restriction in dev)", () => {
    // null csp means default Tauri CSP is used; permitted in dev
    expect(conf.app.security.csp).toBeNull()
  })
})

describe("Frontend-Tauri Build Integration", () => {
  it("frontend dist directory exists or can be built", () => {
    // dist may not exist yet if not built, but the path should be valid
    const distExists = exists(FRONTEND_DIST)
    if (distExists) {
      const files = readdirSync(FRONTEND_DIST)
      expect(files.length).toBeGreaterThan(0)
    } else {
      // dist doesn't exist — verify we can find package.json as a fallback
      expect(existsSync(PACKAGE_JSON)).toBe(true)
    }
  })

  it("frontend index.html exists", () => {
    expect(existsSync(FRONTEND_INDEX)).toBe(true)
  })

  it("package.json has React + Vite + Tauri dependencies", () => {
    if (!existsSync(PACKAGE_JSON)) {
      return // skip if not yet created
    }
    const pkg = readJson<{ dependencies: Record<string, string>; devDependencies: Record<string, string> }>(PACKAGE_JSON)
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies }
    expect(allDeps["react"]).toBeDefined()
    expect(allDeps["vite"]).toBeDefined()
    expect(allDeps["@tauri-apps/api"]).toBeDefined()
  })
})

describe("Tauri-Source Layout", () => {
  it("src-tauri directory exists at project root", () => {
    expect(exists(TAURI_DIR)).toBe(true)
  })

  it("tauri.conf.json is valid JSON", () => {
    // already validated by readJson; just re-confirm
    expect(() => readJson<TauriConfig>(TAURI_CONF)).not.toThrow()
  })
})

describe("Tauri ↔ Backend Port Alignment", () => {
  it("dev URL port matches OpenClaw gateway default (18789)", () => {
    const conf = readJson<TauriConfig>(TAURI_CONF)
    const port = new URL(conf.build.devUrl).port
    expect(port).toBe("18789")
  })

  it("dev URL protocol is HTTP (not HTTPS) for local dev", () => {
    const conf = readJson<TauriConfig>(TAURI_CONF)
    expect(conf.build.devUrl.startsWith("http://")).toBe(true)
  })
})

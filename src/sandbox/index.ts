export { processSandbox } from "./process-sandbox.js"
export { dockerSandbox } from "./docker-sandbox.js"
export type { SandboxOptions, SandboxResult, SandboxProvider } from "./types.js"

import { dockerSandbox } from "./docker-sandbox.js"
import { processSandbox } from "./process-sandbox.js"
import type { SandboxOptions, SandboxResult, SandboxProvider } from "./types.js"

let activeProvider: SandboxProvider = processSandbox

export async function getSandbox(): Promise<SandboxProvider> {
  if (await dockerSandbox.available()) {
    activeProvider = dockerSandbox
  } else {
    activeProvider = processSandbox
  }
  return activeProvider
}

export async function executeInSandbox(opts: SandboxOptions): Promise<SandboxResult> {
  const sandbox = await getSandbox()
  return sandbox.execute(opts)
}

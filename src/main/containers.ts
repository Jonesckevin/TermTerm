import type { ShellProfile } from '../shared/types'
import { decodeOutput, findOnPath, runCapture } from './exec'
import type { SpawnSpec } from './pty/profiles'

export type ContainerEngine = 'docker' | 'podman'

const ENGINES: ContainerEngine[] = ['docker', 'podman']

/** Container names/ids accepted for `exec`; rejects anything that could become a flag. */
const SAFE_CONTAINER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/

const ENGINE_ACCENT: Record<ContainerEngine, string> = {
  docker: '#2496ed',
  podman: '#892ca0'
}

export interface ContainerInfo {
  engine: ContainerEngine
  id: string
  name: string
  image: string
}

export function engineExe(engine: ContainerEngine): string {
  const name = process.platform === 'win32' ? `${engine}.exe` : engine
  return findOnPath(name) ?? name
}

/** Engines that are installed, in preference order. */
export function availableEngines(): ContainerEngine[] {
  return ENGINES.filter((engine) => Boolean(findOnPath(process.platform === 'win32' ? `${engine}.exe` : engine)))
}

/** Parses `docker ps --format '{{.ID}}|{{.Names}}|{{.Image}}'` output. */
export function parseContainerList(engine: ContainerEngine, output: string): ContainerInfo[] {
  const containers: ContainerInfo[] = []
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    const [id, names, image] = line.split('|')
    // `.Names` can list several aliases; the first is the canonical one.
    const name = (names ?? '').split(',')[0]?.trim()
    if (!id || !name || !SAFE_CONTAINER.test(name)) continue
    containers.push({ engine, id: id.trim(), name, image: (image ?? '').trim() })
  }
  return containers
}

export function listContainers(): ContainerInfo[] {
  const containers: ContainerInfo[] = []
  for (const engine of availableEngines()) {
    const out = runCapture(engineExe(engine), ['ps', '--format', '{{.ID}}|{{.Names}}|{{.Image}}'])
    if (!out) continue
    containers.push(...parseContainerList(engine, decodeOutput(out)))
  }
  return containers
}

export function containerProfile(container: ContainerInfo): ShellProfile {
  return {
    id: `container:${container.engine}:${container.name}`,
    name: container.name,
    kind: 'container',
    badge: 'CT',
    accent: ENGINE_ACCENT[container.engine],
    detail: `${container.engine} · ${container.image}`,
    available: true
  }
}

/** Running containers exposed as shells in the command palette. */
export function listContainerProfiles(): ShellProfile[] {
  try {
    return listContainers().map(containerProfile)
  } catch {
    return []
  }
}

export function containerExecSpec(engine: ContainerEngine, container: string, shell = 'sh'): SpawnSpec {
  if (!SAFE_CONTAINER.test(container)) throw new Error(`Invalid container name: ${container}`)
  if (!/^[A-Za-z0-9/_.-]+$/.test(shell)) throw new Error(`Invalid shell: ${shell}`)
  return {
    file: engineExe(engine),
    // -it gives the container an interactive TTY, which is what node-pty provides.
    args: ['exec', '-it', container, shell]
  }
}

/** Splits `container:<engine>:<name>` profile ids back into their parts. */
export function parseContainerProfileId(profileId: string): { engine: ContainerEngine; container: string } | null {
  const match = /^container:(docker|podman):(.+)$/.exec(profileId)
  if (!match) return null
  return { engine: match[1] as ContainerEngine, container: match[2] }
}

// =============================================================================
// signalk-container API mirror
// =============================================================================
//
// Hand-rolled to keep this plugin loosely coupled to signalk-container (a
// runtime companion declared in package.json `signalk.requires`, never a
// compile-time import — the manager is reached purely via globalThis).
//
// Source of truth:
//   https://github.com/dirkwa/signalk-container
//   - src/types.ts
//   - src/updates/types.ts
//
// Last synced against signalk-container: v1.20.2

export type ContainerState = 'running' | 'stopped' | 'missing' | 'no-runtime'

export interface ContainerRuntimeInfo {
  runtime: 'podman' | 'docker'
  version: string
  // Extended diagnostics exist on the real type (isRootless, hostUser,
  // socketPath, cgroupControllers, …); this plugin only reads runtime+version.
}

export interface ContainerResourceLimits {
  cpus?: number | null
  cpuShares?: number | null
  cpusetCpus?: string | null
  memory?: string | null
  memorySwap?: string | null
  memoryReservation?: string | null
  pidsLimit?: number | null
  oomScoreAdj?: number | null
}

/**
 * Per-volume host-source policy. signalk-container honours these for volume
 * entries declared as `{ source, ifMissing }` instead of the bare-string form.
 */
export interface VolumeSpec {
  /** Host path (absolute) or named-volume identifier. */
  source: string
  /**
   * What signalk-container does when `source` is a host path that doesn't exist:
   *  - 'create' (default, same as bare string): runtime auto-creates.
   *  - 'skip': drop the volume; container starts without the mount.
   *    onVolumeIssue fires with action='skipped'.
   *  - 'abort': throw from ensureRunning. onVolumeIssue fires before throw.
   */
  ifMissing?: 'create' | 'skip' | 'abort'
}

/**
 * Single policy event for ensureRunning's onVolumeIssue callback.
 *  - 'skipped':   ifMissing='skip' volume's source was missing; dropped.
 *  - 'aborted':   ifMissing='abort' volume's source was missing; throwing.
 *  - 'recovered': previously-missing source reappeared; container recreated.
 */
export interface VolumeIssue {
  containerPath: string
  source: string
  action: 'skipped' | 'aborted' | 'recovered'
  reason: string
}

export interface EnsureRunningOptions {
  onVolumeIssue?: (issue: VolumeIssue) => void | Promise<void>
  onContainerLog?: (line: string) => void | Promise<void>
  onContainerLogStartTail?: number
  pluginId?: string
  pluginVersion?: string
}

export interface ContainerConfig {
  image: string
  tag: string
  digest?: string
  autoUpdateOnFloatingTag?: boolean
  ports?: Record<string, string>
  /**
   * Per-volume bind config. Bare string is shorthand for
   * `{ source, ifMissing: 'create' }`. Use the VolumeSpec form for optional
   * user-managed paths (e.g. an external chart dir on a USB drive).
   */
  volumes?: Record<string, string | VolumeSpec>
  env?: Record<string, string>
  restart?: 'no' | 'unless-stopped' | 'always'
  networkMode?: string
  user?: { inImageUid?: number; inImageGid?: number } | false
  resources?: ContainerResourceLimits
}

export interface VersionSource {
  fetch: (...args: unknown[]) => Promise<unknown>
}

export interface UpdateRegistration {
  pluginId: string
  containerName: string
  image: string
  currentTag: () => string
  versionSource: VersionSource
  currentVersion?: () => Promise<string | null>
  checkInterval?: string
}

export interface UpdateServiceApi {
  register: (reg: UpdateRegistration) => void
  unregister: (pluginId: string) => void
  sources: {
    githubReleases: (
      repo: string,
      options?: { allowPrerelease?: boolean; tagPrefix?: string }
    ) => VersionSource
    dockerHubTags: (image: string, options?: { filter?: (tag: string) => boolean }) => VersionSource
  }
}

export interface ContainerManagerApi {
  whenReady: () => Promise<void>
  getRuntime: () => ContainerRuntimeInfo | null
  ensureRunning: (
    name: string,
    config: ContainerConfig,
    options?: EnsureRunningOptions
  ) => Promise<void>
  stop: (name: string) => Promise<void>
  // Optional — only present in signalk-container builds that ship it.
  resolveHostPath?: (absPath: string) => Promise<{ source: string; subPath: string } | null>
  updates?: UpdateServiceApi
}

declare global {
  var __signalk_containerManager: ContainerManagerApi | undefined
}

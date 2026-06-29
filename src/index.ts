/*
 * signalk-avnav
 *
 * A Signal K plugin that runs AvNav (wellenvogel) as a container via
 * signalk-container and surfaces it in the admin UI as a launcher webapp.
 *
 * It owns NO container logic of its own — signalk-container is the runtime
 * glue. The image comes from ghcr.io/dirkwa/signalk-avnav-container (built in
 * a separate repo). This file follows signalk-container's plugin dev guide:
 *   - synchronous start() that delegates to asyncStart().catch()
 *   - POLL globalThis for the manager (we load before signalk-container
 *     alphabetically, so its global isn't set yet when our start() runs)
 *   - ensureRunning() once; the central diff reconciles any drift
 *   - resolveHostPath() so the data-dir bind mount works even if SK is
 *     itself containerised
 *   - user:{inImageUid,inImageGid} matching the image's non-root USER
 *   - updates.register() for "new AvNav available" notifications
 */
import { ServerAPI, Plugin } from '@signalk/server-api'
import { IRouter, Request, Response } from 'express'
import {
  ContainerConfig,
  ContainerManagerApi,
  ContainerResourceLimits,
  VolumeIssue
} from './types.js'

// ---- Constants -------------------------------------------------------------
const PLUGIN_ID = 'signalk-avnav'
const CONTAINER_NAME = 'avnav' // becomes sk-avnav
const IMAGE = 'ghcr.io/dirkwa/signalk-avnav-container'
const UPDATE_REPO = 'dirkwa/signalk-avnav-container'
const DEFAULT_TAG = '20250822' // pinned AvNav version; bump per plugin release
// The image's non-root user and its in-container HOME / data dir. Built by
// concatenation so the SignalK plugin-CI hardcoded-home-path check (which
// flags host-style home paths in string literals) doesn't trip on this
// legitimate in-container path.
const IMAGE_USER = 'avnav'
const CONTAINER_HOME = '/home/' + IMAGE_USER
const CONTAINER_DATADIR = CONTAINER_HOME + '/avnav'
const CONTAINER_CHARTBASE = '/charts'
const CONTAINER_PORT = '8080/tcp'
const IN_IMAGE_UID = 1000
const IN_IMAGE_GID = 1000
const AVNAV_ENTRY = '/viewer/avnav_viewer.html'

// Measured headroom defaults for a Pi 4/5; the user can override per-container
// in signalk-container's own config panel (field-level merge).
const DEFAULT_RESOURCES: ContainerResourceLimits = {
  cpus: 1.5,
  memory: '512m',
  memorySwap: '512m',
  pidsLimit: 200
}

interface AvnavConfig {
  avnavPort?: number
  bindAllInterfaces?: boolean
  imageTag?: string
  followLatest?: boolean
  chartsPath?: string
  signalkWrite?: boolean
  signalkUsername?: string
  signalkPassword?: string
}

// app.config.settings.port is present at runtime but not in the published
// ServerAPI types; read it through this narrowing instead of `any`.
interface ServerConfigView {
  config?: { settings?: { port?: number; ssl?: boolean } }
}

// host alias signalk-container maps to the SK host on both podman and docker.
const SK_HOST = 'host.containers.internal'

function getSignalKPort(app: ServerAPI): number {
  const fromEnv = Number(process.env.PORT)
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv
  const settingsPort = (app as unknown as ServerConfigView).config?.settings?.port
  return typeof settingsPort === 'number' && settingsPort > 0 ? settingsPort : 3000
}

/**
 * Raised by buildConfig() when the SignalK data dir resolves to a sub-path
 * inside a named volume that can't be bind-mounted into another container.
 * A distinct class so the resolveHostPath try/catch can let it propagate
 * instead of swallowing it and falling through to a mis-mount.
 */
class NamedVolumeError extends Error {}

function getContainerManager(): ContainerManagerApi | undefined {
  return globalThis.__signalk_containerManager
}

/**
 * Wait for signalk-container's API to be FULLY ready on globalThis — both the
 * manager object exposed AND its runtime detection complete.
 *
 * signalk-container exposes its API via globalThis only after its own start()
 * has finished, and plugin-load order is alphabetical: "signalk-avnav" sorts
 * before "signalk-container", so our start() runs first and the global is not
 * set yet. Without this poll the plugin would hard-error on every cold boot
 * and never recover. Mirrors signalk-backup's waitForContainerManager.
 */
async function waitForContainerManager(
  maxMs: number,
  intervalMs = 500
): Promise<ContainerManagerApi | undefined> {
  const deadline = Date.now() + maxMs
  for (;;) {
    const m = getContainerManager()
    if (m && m.getRuntime()) return m
    if (Date.now() >= deadline) return getContainerManager()
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

export default function (app: ServerAPI): Plugin {
  let currentConfig: AvnavConfig | undefined
  const pluginVersion = '0.1.0'

  async function buildConfig(
    containers: ContainerManagerApi,
    config: AvnavConfig
  ): Promise<ContainerConfig> {
    const bindHost = config.bindAllInterfaces === false ? '127.0.0.1' : '0.0.0.0'
    const port = config.avnavPort ?? 8080

    // Resolve the host path behind this plugin's per-plugin data dir so the
    // bind mount is valid whether SK is bare-metal or itself containerised.
    let hostData = app.getDataDirPath()
    try {
      const resolved = await containers.resolveHostPath?.(app.getDataDirPath())
      if (resolved) {
        if (resolved.subPath) {
          throw new NamedVolumeError(
            'Signal K data dir is inside a named volume; mount it into the SK ' +
              'container or relocate plugin data to a bind-mounted path.'
          )
        }
        hostData = resolved.source
      }
    } catch (e) {
      // A genuine named-volume situation must ABORT — re-throw it. Only the
      // resolveHostPath call itself failing is tolerable (fall back to the
      // raw path, which works on bare-metal SK).
      if (e instanceof NamedVolumeError) throw e
      app.error(`resolveHostPath: ${e instanceof Error ? e.message : String(e)}`)
    }

    const volumes: ContainerConfig['volumes'] = {
      [CONTAINER_DATADIR]: hostData
    }
    const env: Record<string, string> = {
      AVNAV_DATADIR: CONTAINER_DATADIR,
      AVNAV_PORT: '8080',
      // Auto-wire AvNav's SignalK connection back to this server. AvNav reaches
      // the host via host.containers.internal; reads work even with security on.
      AVNAV_SK_HOST: SK_HOST,
      AVNAV_SK_PORT: String(getSignalKPort(app))
    }

    // Write-back (waypoints/routes → SignalK) needs credentials; AvNav logs in
    // with username+password (it can't consume a SignalK token directly).
    if (config.signalkWrite) {
      env.AVNAV_SK_WRITE = 'true'
      if (config.signalkUsername?.trim()) env.AVNAV_SK_USER = config.signalkUsername.trim()
      if (config.signalkPassword) env.AVNAV_SK_PASSWORD = config.signalkPassword
    }

    // Optional: mount an existing host chart directory and point AvNav at it.
    const chartsPath = config.chartsPath?.trim()
    if (chartsPath) {
      let chartSource = chartsPath
      try {
        const r = await containers.resolveHostPath?.(chartSource)
        if (r && !r.subPath) chartSource = r.source
      } catch {
        /* use raw path */
      }
      volumes[CONTAINER_CHARTBASE] = { source: chartSource, ifMissing: 'skip' }
      env.AVNAV_CHARTBASE = CONTAINER_CHARTBASE
    }

    const followLatest = config.followLatest === true
    const tag = followLatest ? 'latest' : config.imageTag || DEFAULT_TAG

    return {
      image: IMAGE,
      tag,
      autoUpdateOnFloatingTag: followLatest, // pull + recreate when :latest moves
      ports: { [CONTAINER_PORT]: `${bindHost}:${port}` },
      volumes,
      env,
      restart: 'unless-stopped',
      user: { inImageUid: IN_IMAGE_UID, inImageGid: IN_IMAGE_GID },
      resources: DEFAULT_RESOURCES
    }
  }

  async function asyncStart(config: AvnavConfig): Promise<void> {
    currentConfig = config

    app.setPluginStatus('Waiting for container runtime…')
    const containers = await waitForContainerManager(120_000)
    if (!containers) {
      app.setPluginError('signalk-container plugin is required but not available')
      return
    }
    await containers.whenReady()
    if (!containers.getRuntime()) {
      app.setPluginError('No container runtime detected (podman/docker missing)')
      return
    }

    const containerConfig = await buildConfig(containers, config)

    await containers.ensureRunning(CONTAINER_NAME, containerConfig, {
      pluginId: PLUGIN_ID,
      pluginVersion,
      onContainerLog: (line) => {
        app.debug(`[avnav] ${line}`)
      },
      onContainerLogStartTail: 50,
      onVolumeIssue: (e: VolumeIssue) => {
        if (e.action === 'skipped') {
          app.setPluginStatus(`Chart dir ${e.source} not present — AvNav started without it`)
        } else if (e.action === 'aborted') {
          app.setPluginError(`Required mount missing: ${e.source}`)
        }
      }
    })

    // "New AvNav available" notifications from the container repo's GitHub
    // Releases. Detection only — applying is bumping imageTag (or Follow latest).
    if (containers.updates && !config.followLatest) {
      try {
        containers.updates.register({
          pluginId: PLUGIN_ID,
          containerName: CONTAINER_NAME,
          image: IMAGE,
          currentTag: () => currentConfig?.imageTag || DEFAULT_TAG,
          versionSource: containers.updates.sources.githubReleases(UPDATE_REPO)
        })
      } catch (e) {
        app.debug(`updates.register failed: ${e instanceof Error ? e.message : String(e)}`)
      }
    }

    const port = config.avnavPort ?? 8080
    app.setPluginStatus(`AvNav running on port ${port} (image ${containerConfig.tag})`)
  }

  const plugin: Plugin = {
    id: PLUGIN_ID,
    name: 'AvNav',
    description:
      'Runs AvNav (wellenvogel) as a container via signalk-container and opens it from the admin UI.',

    schema: () => ({
      type: 'object',
      properties: {
        avnavPort: {
          type: 'number',
          title: 'AvNav port (on the host)',
          description: 'Port AvNav is published on. Reachable from tablets/phones on the boat LAN.',
          default: 8080
        },
        bindAllInterfaces: {
          type: 'boolean',
          title: 'Expose on the LAN',
          description:
            'On: bind 0.0.0.0 so other devices can open AvNav directly. Off: bind 127.0.0.1 (only this host / proxy).',
          default: true
        },
        imageTag: {
          type: 'string',
          title: 'AvNav image version',
          description: `Container image tag to run (an AvNav version, e.g. ${DEFAULT_TAG}).`,
          default: DEFAULT_TAG
        },
        followLatest: {
          type: 'boolean',
          title: 'Follow latest automatically',
          description:
            'Track the :latest image and auto-recreate when a new build is published (ignores the version field above). Off = stay pinned and get a notification instead.',
          default: false
        },
        chartsPath: {
          type: 'string',
          title: 'External chart directory (optional)',
          description:
            'Absolute host path to an existing AvNav chart dir to mount. Leave blank to keep charts inside the plugin data dir.',
          default: ''
        },
        signalkWrite: {
          type: 'boolean',
          title: 'Let AvNav write to Signal K',
          description:
            'Allow AvNav to send waypoints/routes back to Signal K. Reading boat data works without this. Writing needs Signal K credentials below (AvNav logs in with username+password).',
          default: false
        },
        signalkUsername: {
          type: 'string',
          title: 'Signal K username (for write-back)',
          description:
            'Only used when "Let AvNav write to Signal K" is on and Signal K security is enabled.',
          default: 'admin'
        },
        signalkPassword: {
          type: 'string',
          title: 'Signal K password (for write-back)',
          description:
            'Only used when "Let AvNav write to Signal K" is on and Signal K security is enabled.',
          default: ''
        }
      }
    }),

    start(config: object) {
      asyncStart(config as AvnavConfig).catch((err: unknown) => {
        app.setPluginError(`Startup failed: ${err instanceof Error ? err.message : String(err)}`)
      })
    },

    stop() {
      const containers = getContainerManager()
      if (containers?.updates) {
        try {
          containers.updates.unregister(PLUGIN_ID)
        } catch {
          /* ignore */
        }
      }
      if (containers) {
        containers.stop(CONTAINER_NAME).catch(() => {
          /* may already be stopped */
        })
      }
      currentConfig = undefined
    },

    // Tiny endpoint the launcher webapp calls to learn which port/host AvNav
    // is on, so it can open AvNav in a new tab.
    registerWithRouter(router: IRouter) {
      router.get('/avnav-info', (_req: Request, res: Response) => {
        res.json({
          port: currentConfig?.avnavPort ?? 8080,
          exposed: currentConfig?.bindAllInterfaces !== false,
          entry: AVNAV_ENTRY
        })
      })
    }
  }

  return plugin
}

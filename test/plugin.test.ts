import { describe, it, expect, afterEach, vi } from 'vitest'
import type { ServerAPI } from '@signalk/server-api'
import type { IRouter, Request, Response } from 'express'
import createPlugin from '../src/index.js'
import type { ContainerConfig, ContainerManagerApi, EnsureRunningOptions } from '../src/types.js'

// ---- Test doubles ----------------------------------------------------------

interface AppStub extends Partial<ServerAPI> {
  status: string
  errorMsg: string | null
}

function makeApp(dataDir = '/data/.signalk/plugin-config-data/signalk-avnav'): AppStub {
  const app: AppStub = {
    status: '',
    errorMsg: null,
    setPluginStatus: vi.fn((s: string) => {
      app.status = s
    }),
    setPluginError: vi.fn((s: string) => {
      app.errorMsg = s
    }),
    getDataDirPath: () => dataDir,
    debug: () => {},
    error: () => {}
  }
  return app
}

interface ManagerStub extends ContainerManagerApi {
  lastEnsure?: { name: string; config: ContainerConfig; options?: EnsureRunningOptions }
  registered: boolean
}

function makeManager(): ManagerStub {
  const m: ManagerStub = {
    registered: false,
    whenReady: () => Promise.resolve(),
    getRuntime: () => ({ runtime: 'podman', version: '5.0.0' }),
    ensureRunning: (name, config, options) => {
      m.lastEnsure = { name, config, options }
      return Promise.resolve()
    },
    stop: () => Promise.resolve(),
    resolveHostPath: (absPath: string) => Promise.resolve({ source: absPath, subPath: '' }),
    updates: {
      register: () => {
        m.registered = true
      },
      unregister: () => {
        m.registered = false
      },
      sources: {
        githubReleases: () => ({ fetch: () => Promise.resolve(null) }),
        dockerHubTags: () => ({ fetch: () => Promise.resolve(null) })
      }
    }
  }
  return m
}

/** Capture the route handler registered for GET /avnav-info. */
function makeRouter(): { router: IRouter; getInfo: () => unknown } {
  let handler: ((req: Request, res: Response) => void) | undefined
  const router = {
    get: (path: string, h: (req: Request, res: Response) => void) => {
      if (path === '/avnav-info') handler = h
    }
  } as unknown as IRouter
  return {
    router,
    getInfo: () => {
      let body: unknown
      const res = { json: (b: unknown) => (body = b) } as unknown as Response
      handler?.({} as Request, res)
      return body
    }
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

afterEach(() => {
  delete globalThis.__signalk_containerManager
  vi.useRealTimers()
})

describe('schema', () => {
  it('exposes the config fields with sane defaults', () => {
    const app = makeApp()
    const plugin = createPlugin(app as unknown as ServerAPI)
    const schema = plugin.schema() as {
      properties: Record<string, { default?: unknown }>
    }
    expect(Object.keys(schema.properties).sort()).toEqual([
      'avnavPort',
      'bindAllInterfaces',
      'chartsPath',
      'followLatest',
      'imageTag',
      'signalkPassword',
      'signalkUsername',
      'signalkWrite'
    ])
    expect(schema.properties.avnavPort?.default).toBe(8080)
    expect(schema.properties.bindAllInterfaces?.default).toBe(true)
    expect(schema.properties.followLatest?.default).toBe(false)
    expect(schema.properties.signalkWrite?.default).toBe(false)
  })
})

describe('/avnav-info endpoint', () => {
  it('reports the configured port, exposure and AvNav entry path', () => {
    const app = makeApp()
    const manager = makeManager()
    globalThis.__signalk_containerManager = manager
    const plugin = createPlugin(app as unknown as ServerAPI)
    plugin.start({ avnavPort: 8099, bindAllInterfaces: false }, () => {})
    const { router, getInfo } = makeRouter()
    plugin.registerWithRouter?.(router)
    expect(getInfo()).toEqual({
      port: 8099,
      exposed: false,
      entry: '/viewer/avnav_viewer.html'
    })
  })

  it('defaults to port 8080 and exposed when started with empty config', () => {
    const app = makeApp()
    globalThis.__signalk_containerManager = makeManager()
    const plugin = createPlugin(app as unknown as ServerAPI)
    plugin.start({}, () => {})
    const { router, getInfo } = makeRouter()
    plugin.registerWithRouter?.(router)
    expect(getInfo()).toEqual({ port: 8080, exposed: true, entry: '/viewer/avnav_viewer.html' })
  })
})

describe('container config', () => {
  it('pins to imageTag and maps the port to the configured bind host', async () => {
    const app = makeApp()
    const manager = makeManager()
    globalThis.__signalk_containerManager = manager
    const plugin = createPlugin(app as unknown as ServerAPI)
    plugin.start({ imageTag: '20250822', avnavPort: 8080, bindAllInterfaces: true }, () => {})
    await flush()
    const cfg = manager.lastEnsure?.config
    expect(cfg?.tag).toBe('20250822')
    expect(cfg?.autoUpdateOnFloatingTag).toBe(false)
    expect(cfg?.ports).toEqual({ '8080/tcp': '0.0.0.0:8080' })
    expect(cfg?.user).toEqual({ inImageUid: 1000, inImageGid: 1000 })
    expect(manager.registered).toBe(true)
  })

  it('uses the :latest tag and skips update registration when followLatest is on', async () => {
    const app = makeApp()
    const manager = makeManager()
    globalThis.__signalk_containerManager = manager
    const plugin = createPlugin(app as unknown as ServerAPI)
    plugin.start({ followLatest: true, bindAllInterfaces: false }, () => {})
    await flush()
    const cfg = manager.lastEnsure?.config
    expect(cfg?.tag).toBe('latest')
    expect(cfg?.autoUpdateOnFloatingTag).toBe(true)
    expect(cfg?.ports).toEqual({ '8080/tcp': '127.0.0.1:8080' })
    expect(manager.registered).toBe(false)
  })

  it('auto-wires the SignalK host+port and omits write creds by default', async () => {
    const app = makeApp()
    const manager = makeManager()
    globalThis.__signalk_containerManager = manager
    const plugin = createPlugin(app as unknown as ServerAPI)
    plugin.start({}, () => {})
    await flush()
    const env = manager.lastEnsure?.config.env
    expect(env?.AVNAV_SK_HOST).toBe('host.containers.internal')
    expect(env?.AVNAV_SK_PORT).toBe('3000') // default when app.config has no port
    expect(env?.AVNAV_SK_WRITE).toBeUndefined()
    expect(env?.AVNAV_SK_USER).toBeUndefined()
    expect(env?.AVNAV_SK_PASSWORD).toBeUndefined()
  })

  it('passes write creds only when signalkWrite is enabled', async () => {
    const app = makeApp()
    const manager = makeManager()
    globalThis.__signalk_containerManager = manager
    const plugin = createPlugin(app as unknown as ServerAPI)
    plugin.start(
      { signalkWrite: true, signalkUsername: 'avnav', signalkPassword: 'secret' },
      () => {}
    )
    await flush()
    const env = manager.lastEnsure?.config.env
    expect(env?.AVNAV_SK_WRITE).toBe('true')
    expect(env?.AVNAV_SK_USER).toBe('avnav')
    expect(env?.AVNAV_SK_PASSWORD).toBe('secret')
  })
})

describe('cold-boot startup race', () => {
  it('waits for the manager global that appears AFTER start() runs', async () => {
    vi.useFakeTimers()
    const app = makeApp()
    const plugin = createPlugin(app as unknown as ServerAPI)

    // Manager not present yet — mirrors signalk-avnav loading before
    // signalk-container alphabetically.
    plugin.start({}, () => {})
    await vi.advanceTimersByTimeAsync(0)
    expect(app.errorMsg).toBeNull() // must NOT have errored out immediately

    // signalk-container finishes its own start() and publishes the global.
    const manager = makeManager()
    globalThis.__signalk_containerManager = manager
    await vi.advanceTimersByTimeAsync(600) // past the 500ms poll interval

    expect(manager.lastEnsure?.name).toBe('avnav')
    expect(app.errorMsg).toBeNull()
  })
})

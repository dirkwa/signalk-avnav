# signalk-avnav

Runs [AvNav](https://www.wellenvogel.net/software/avnav/) as a container managed by
[`signalk-container`](https://github.com/dirkwa/signalk-container), and adds an **AvNav**
launcher to the Signal K admin UI. The image is built separately in
[`signalk-avnav-container`](https://github.com/dirkwa/signalk-avnav-container).

This is the same pattern as `signalk-backup`: the plugin is the npm package; it hands
signalk-container a `ContainerConfig` and owns the UX. No container logic lives here.

## Requirements

- `signalk-container` installed and enabled (provides the runtime glue). Declared as a
  companion in `signalk.requires`.
- A container runtime (rootless Podman recommended) on the Signal K host.

## What it does on start

1. Polls for the container manager (`globalThis.__signalk_containerManager`) — the plugin
   loads before signalk-container alphabetically, so it waits up to 120 s for the global
   to appear and for the runtime to be detected.
2. `ensureRunning('avnav', …)` with:
   - image `ghcr.io/dirkwa/signalk-avnav-container:<version>`
   - the plugin's data dir bind-mounted to AvNav's data dir (via `resolveHostPath`, so it
     works whether SK is bare-metal or containerised)
   - `user:{inImageUid:1000,inImageGid:1000}` to keep bind-mount files owned by the SK user
   - sensible CPU/memory caps (override per-container in signalk-container's own UI)
3. Registers for update notifications against the container repo's GitHub Releases.

## The webapp

AvNav is a full navigation app served on its own host port and designed to be used
full-screen on tablets and phones. The **Webapps → AvNav** entry is a `signalk-webapp`
(standalone, not an embedded panel): clicking it loads a tiny redirect page that resolves
AvNav's configured port from the plugin's `/avnav-info` endpoint and sends the browser
straight to AvNav full-screen. Reading the port at click time means it always reflects the
configured `avnavPort` (no iframe, no module federation).

## Configuration

| Option | Default | Notes |
| --- | --- | --- |
| AvNav port (on the host) | `8080` | Where AvNav is published; reachable from tablets on the boat LAN. |
| Expose on the LAN | on | On binds `0.0.0.0`; off binds `127.0.0.1`. |
| AvNav image version | pinned | Image tag (an AvNav version). Bump to upgrade. |
| Follow latest automatically | off | Track `:latest` and auto-recreate on new builds. Off = stay pinned + get notified. |
| External chart directory | — | Optional absolute host path mounted into the container; AvNav points at it. |
| Let AvNav write to Signal K | off | Allow AvNav to send waypoints/routes back. Reading boat data needs no creds. |
| Signal K username / password | `admin` / — | Only used for write-back when Signal K security is enabled. |

## Connecting AvNav to Signal K

This is **automatic** — you don't configure it in AvNav. On start the plugin discovers the
Signal K server's port and tells the container to point AvNav at
`host.containers.internal:<port>` (signalk-container maps that alias to the host on both
Podman and Docker). The container entrypoint seeds AvNav's `avnav_server.xml` with that
host/port, so AvNav connects on first run and reflects the live port if you change it.

**Reading boat data works out of the box**, even with Signal K security enabled. AvNav only
needs credentials to *write* back (waypoints, routes): turn on **Let AvNav write to Signal K**
and set the username/password. AvNav authenticates by logging in (it can't consume a Signal K
token directly), so write-back uses username+password, not the access-request flow.

## Build / publish

```bash
npm install
npm run build:all      # lint + tsc -> plugin/, vite -> public/, vitest
```

Tag `vX.Y.Z` to publish to npm (CI validates the tag, cuts a GitHub Release, builds, tests,
and publishes with provenance). Bump `DEFAULT_TAG` in `src/index.ts` to pin a newer AvNav
image for a plugin release.

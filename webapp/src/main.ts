/*
 * AvNav webapp = a redirect.
 *
 * The admin Webapps menu links to this page at the static, server-relative path
 * /signalk-avnav/ (it cannot link to an absolute host:port URL). AvNav itself
 * runs as its own full-screen SPA on a user-configurable host port, so this page
 * resolves that port from the plugin's /avnav-info endpoint and sends the browser
 * straight to AvNav. One invisible hop, then AvNav full-screen. Reading the port
 * at click time means it always reflects the configured port.
 */
interface AvnavInfo {
  port: number
  exposed: boolean
  entry: string
}

const INFO_URL = '/plugins/signalk-avnav/avnav-info'

function avnavUrl(info: AvnavInfo): string {
  // AvNav serves plain http on its own port; force the scheme rather than
  // inheriting the admin page's (which may be https — AvNav can't answer that).
  return `http://${location.hostname}:${info.port}${info.entry || '/'}`
}

function showError(message: string): void {
  const msg = document.getElementById('msg')
  if (msg) {
    msg.innerHTML =
      'Could not reach AvNav. Make sure the <b>AvNav</b> plugin is enabled and the ' +
      'container is running, then reload.<br><br><small>' +
      message +
      '</small>'
  }
}

async function main(): Promise<void> {
  try {
    const res = await fetch(INFO_URL, { cache: 'no-store' })
    if (!res.ok) throw new Error(`plugin endpoint returned ${res.status}`)
    const info = (await res.json()) as AvnavInfo
    location.replace(avnavUrl(info))
  } catch (e) {
    showError(e instanceof Error ? e.message : String(e))
  }
}

void main()

import type { Remote, RemoteChanges, RemoteEntry } from './engine'

export class SignedOut extends Error {
  constructor() {
    super('Please sign in again.')
  }
}

export class QuotaFull extends Error {
  constructor() {
    super('Your Notaboek storage is full.')
  }
}

interface ClientOptions {
  baseUrl: string
  device: string
  // Cookies do this in the browser. The desktop app sends a token.
  headers?: () => Record<string, string>
  fetch?: typeof fetch
}

// Talks to the sync API. The request itself is all that differs between devices.
export function createRemote({ baseUrl, device, headers = () => ({}), fetch: send = fetch }: ClientOptions): Remote {
  const request = async (path: string, init: RequestInit = {}) => {
    const response = await send(`${baseUrl}/api/sync${path}`, {
      ...init,
      credentials: 'same-origin',
      headers: { ...headers(), 'x-folio-device': device, ...init.headers }
    })
    if (response.status === 401) throw new SignedOut()
    if (response.status === 507) throw new QuotaFull()
    return response
  }

  const entryOrConflict = async (response: Response): Promise<RemoteEntry | 'conflict'> => {
    if (response.status === 409) return 'conflict'
    if (!response.ok) throw new Error(`The server refused that change (${response.status}).`)
    return (await response.json()) as RemoteEntry
  }

  return {
    async changes(since) {
      const response = await request(`/changes?since=${since}`)
      if (!response.ok) throw new Error(`Could not reach Notaboek's servers (${response.status}).`)
      return (await response.json()) as RemoteChanges
    },

    async download(id) {
      const response = await request(`/file/${id}`)
      if (!response.ok) throw new Error(`Could not download a page (${response.status}).`)
      return new Uint8Array(await response.arrayBuffer())
    },

    async upload({ id, path, baseRev, bytes }) {
      const response = await request('/file', {
        method: 'PUT',
        body: bytes as BodyInit,
        headers: {
          'content-type': 'application/octet-stream',
          'x-folio-path': encodeURIComponent(path),
          'x-folio-base-rev': String(baseRev),
          ...(id ? { 'x-folio-id': id } : {})
        }
      })
      return entryOrConflict(response)
    },

    async rename(id, path, baseRev) {
      const response = await request(`/file/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ path, baseRev }),
        headers: { 'content-type': 'application/json' }
      })
      return entryOrConflict(response)
    },

    async remove(id, baseRev) {
      const response = await request(`/file/${id}?baseRev=${baseRev}`, { method: 'DELETE' })
      return entryOrConflict(response)
    }
  }
}

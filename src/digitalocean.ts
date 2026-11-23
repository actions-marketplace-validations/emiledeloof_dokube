/**
 * Minimal DigitalOcean API client for the Kubernetes endpoints this action uses.
 */

export const DEFAULT_API_URL = "https://api.digitalocean.com/v2"

/** Max page size the DigitalOcean API allows. */
const PAGE_SIZE = 200

const REQUEST_TIMEOUT_MS = 30_000

export interface Cluster {
  id: string
  name: string
  region: string
}

export interface ClusterCredentials {
  server: string
  certificate_authority_data: string
  token: string
  expires_at?: string
}

interface ListClustersResponse {
  kubernetes_clusters?: Cluster[]
  links?: { pages?: { next?: string } }
}

export class DigitalOceanApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = "DigitalOceanApiError"
  }
}

export class DigitalOceanClient {
  private readonly baseUrl: string

  /**
   * @param token DigitalOcean personal access token.
   * @param baseUrl API base URL. Defaults to `DOKUBE_API_URL` if set (used for
   *   testing against a mock API), otherwise the real DigitalOcean API.
   */
  constructor(
    private readonly token: string,
    baseUrl: string = process.env.DOKUBE_API_URL || DEFAULT_API_URL,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "")
  }

  /** List every Kubernetes cluster on the account, following pagination. */
  async listClusters(): Promise<Cluster[]> {
    const clusters: Cluster[] = []
    // Pages are requested by number rather than by following `links.pages.next`
    // so the token is only ever sent to the configured base URL.
    for (let page = 1; ; page++) {
      const data = await this.request<ListClustersResponse>(
        "/kubernetes/clusters",
        { page: String(page), per_page: String(PAGE_SIZE) },
      )
      const batch = data.kubernetes_clusters ?? []
      clusters.push(...batch)
      if (!data.links?.pages?.next || batch.length === 0) return clusters
    }
  }

  async findClusterByName(name: string): Promise<Cluster> {
    const clusters = await this.listClusters()
    const cluster = clusters.find((c) => c.name === name)
    if (!cluster) {
      const names = clusters.map((c) => c.name)
      const shown = names.slice(0, 10).join(", ") || "none"
      const more = names.length > 10 ? ` and ${names.length - 10} more` : ""
      const available = shown + more
      throw new Error(
        `No cluster found with name '${name}'. Clusters on this account: ${available}.`,
      )
    }
    return cluster
  }

  async getCluster(id: string): Promise<Cluster> {
    const data = await this.request<{ kubernetes_cluster: Cluster }>(
      `/kubernetes/clusters/${encodeURIComponent(id)}`,
    )
    return data.kubernetes_cluster
  }

  async getCredentials(
    clusterId: string,
    expirySeconds: number,
  ): Promise<ClusterCredentials> {
    return this.request<ClusterCredentials>(
      `/kubernetes/clusters/${encodeURIComponent(clusterId)}/credentials`,
      { expiry_seconds: String(expirySeconds) },
    )
  }

  private async request<T>(
    path: string,
    params: Record<string, string> = {},
  ): Promise<T> {
    const url = new URL(this.baseUrl + path)
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value)
    }

    let response: Response
    try {
      response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch (error) {
      // fetch() only says "fetch failed"; the useful detail is in `cause`.
      const cause =
        error instanceof Error && error.cause instanceof Error
          ? error.cause.message
          : String(error)
      throw new Error(
        `Could not reach the DigitalOcean API at ${url.origin}: ${cause}`,
        { cause: error },
      )
    }

    if (!response.ok) {
      throw new DigitalOceanApiError(
        await describeError(response),
        response.status,
      )
    }
    return (await response.json()) as T
  }
}

async function describeError(response: Response): Promise<string> {
  let detail = ""
  try {
    const body = (await response.json()) as { message?: string }
    detail = body.message ?? ""
  } catch {
    // Body wasn't JSON; fall back to the status text.
  }
  detail ||= response.statusText

  switch (response.status) {
    case 401:
      return `DigitalOcean rejected the access token (401: ${detail}). Check that personalAccessToken is valid and has read access to Kubernetes.`
    case 403:
      return `The access token is not allowed to perform this request (403: ${detail}). Make sure it has the kubernetes:read and kubernetes:access_cluster scopes.`
    case 404:
      return `DigitalOcean resource not found (404: ${detail}).`
    default:
      return `DigitalOcean API request failed (${response.status}: ${detail}).`
  }
}

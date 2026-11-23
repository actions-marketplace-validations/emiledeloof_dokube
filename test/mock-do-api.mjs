#!/usr/bin/env node
/**
 * A tiny fake of the DigitalOcean Kubernetes API, for testing the action
 * without a DigitalOcean account.
 *
 * Implements:
 *   GET /v2/kubernetes/clusters                  (paginated)
 *   GET /v2/kubernetes/clusters/:id
 *   GET /v2/kubernetes/clusters/:id/credentials
 *
 * The credentials it hands out point at whatever Kubernetes API server you give
 * it (e.g. a local kind cluster), so `kubectl` can run against a real cluster.
 *
 * CLI usage (all env vars optional):
 *   MOCK_PORT=8787                 port to listen on (0 = random)
 *   MOCK_ACCESS_TOKEN=test-token   the personalAccessToken the action must send
 *   MOCK_CLUSTER_NAME=e2e-cluster  name of the cluster the action should find
 *   MOCK_CLUSTER_REGION=nyc1
 *   MOCK_FILLER_CLUSTERS=250       extra clusters, to exercise pagination
 *   MOCK_K8S_SERVER=https://...    API server put into the credentials
 *   MOCK_K8S_CA_DATA=<base64>      CA bundle put into the credentials
 *   MOCK_K8S_TOKEN=<token>         bearer token put into the credentials
 *
 *   node test/mock-do-api.mjs
 *   # then run the action with DOKUBE_API_URL=http://127.0.0.1:8787/v2
 */

import { createServer } from "node:http"
import { pathToFileURL } from "node:url"

/**
 * @typedef {object} MockOptions
 * @property {string} [accessToken]
 * @property {{ id: string, name: string, region: string }[]} [clusters]
 * @property {{ server: string, certificate_authority_data: string, token: string }} [credentials]
 */

/** ID of the cluster `makeClusters` puts last in the list. */
export const TARGET_CLUSTER_ID = "11111111-2222-3333-4444-555555555555"

/**
 * Build a list of clusters: `fillerCount` decoys plus the target cluster last,
 * so finding it requires walking every page.
 */
export function makeClusters(
  name = "e2e-cluster",
  region = "nyc1",
  fillerCount = 0,
) {
  const clusters = []
  for (let i = 0; i < fillerCount; i++) {
    clusters.push({ id: `filler-${i}`, name: `filler-${i}`, region: "ams3" })
  }
  clusters.push({ id: TARGET_CLUSTER_ID, name, region })
  return clusters
}

/**
 * Start the mock server.
 *
 * @param {MockOptions & { port?: number }} [options]
 * @returns {Promise<{ url: string, requests: { path: string, query: Record<string, string> }[], close: () => Promise<void> }>}
 */
export async function startMockApi(options = {}) {
  const accessToken = options.accessToken ?? "test-token"
  const clusters = options.clusters ?? makeClusters()
  const credentials = options.credentials ?? {
    server: "https://127.0.0.1:6443",
    certificate_authority_data: Buffer.from("fake-ca").toString("base64"),
    token: "fake-cluster-token",
  }
  /** @type {{ path: string, query: Record<string, string> }[]} */
  const requests = []

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost")
    requests.push({
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
    })

    /** @param {number} status @param {unknown} body */
    const send = (status, body) => {
      res.writeHead(status, { "Content-Type": "application/json" })
      res.end(JSON.stringify(body))
    }

    if (req.headers.authorization !== `Bearer ${accessToken}`) {
      return send(401, {
        id: "Unauthorized",
        message: "Unable to authenticate you",
      })
    }

    if (url.pathname === "/v2/kubernetes/clusters") {
      const page = Number(url.searchParams.get("page") ?? 1)
      const perPage = Math.min(
        Number(url.searchParams.get("per_page") ?? 20),
        200,
      )
      const start = (page - 1) * perPage
      const hasNext = start + perPage < clusters.length
      return send(200, {
        kubernetes_clusters: clusters.slice(start, start + perPage),
        links: hasNext
          ? {
              pages: {
                next: `https://api.digitalocean.com/v2/kubernetes/clusters?page=${page + 1}&per_page=${perPage}`,
              },
            }
          : {},
        meta: { total: clusters.length },
      })
    }

    const match = /^\/v2\/kubernetes\/clusters\/([^/]+)(\/credentials)?$/.exec(
      url.pathname,
    )
    const cluster =
      match && clusters.find((c) => c.id === decodeURIComponent(match[1]))
    if (match && !cluster) {
      return send(404, {
        id: "not_found",
        message: "The resource you were accessing could not be found.",
      })
    }
    if (cluster && match?.[2]) {
      const expiry = Number(url.searchParams.get("expiry_seconds") ?? 604800)
      return send(200, {
        ...credentials,
        expires_at: new Date(Date.now() + expiry * 1000).toISOString(),
      })
    }
    if (cluster) {
      return send(200, { kubernetes_cluster: cluster })
    }

    send(404, { id: "not_found", message: `No mock route for ${url.pathname}` })
  })

  await new Promise((resolve) =>
    server.listen(options.port ?? 0, "127.0.0.1", () => resolve(undefined)),
  )
  const address = server.address()
  const port = typeof address === "object" && address ? address.port : 0

  return {
    url: `http://127.0.0.1:${port}/v2`,
    requests,
    close: () =>
      new Promise((resolve) => server.close(() => resolve(undefined))),
  }
}

// Run as a standalone server when executed directly.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const env = process.env
  const mock = await startMockApi({
    port: Number(env.MOCK_PORT ?? 8787),
    accessToken: env.MOCK_ACCESS_TOKEN ?? "test-token",
    clusters: makeClusters(
      env.MOCK_CLUSTER_NAME ?? "e2e-cluster",
      env.MOCK_CLUSTER_REGION ?? "nyc1",
      Number(env.MOCK_FILLER_CLUSTERS ?? 250),
    ),
    credentials: {
      server: env.MOCK_K8S_SERVER ?? "https://127.0.0.1:6443",
      certificate_authority_data:
        env.MOCK_K8S_CA_DATA ?? Buffer.from("fake-ca").toString("base64"),
      token: env.MOCK_K8S_TOKEN ?? "fake-cluster-token",
    },
  })
  console.log(`Mock DigitalOcean API listening on ${mock.url}`)
  const shutdown = () => mock.close().then(() => process.exit(0))
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
}

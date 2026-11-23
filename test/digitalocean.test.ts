import { afterEach, describe, expect, it } from "vitest"

import {
  DigitalOceanApiError,
  DigitalOceanClient,
} from "../src/digitalocean.js"
import {
  TARGET_CLUSTER_ID,
  makeClusters,
  startMockApi,
} from "./mock-do-api.mjs"

type Mock = Awaited<ReturnType<typeof startMockApi>>

describe("DigitalOceanClient", () => {
  let mock: Mock | undefined
  afterEach(async () => {
    await mock?.close()
    mock = undefined
  })

  it("follows pagination to find a cluster past the first page", async () => {
    mock = await startMockApi({ clusters: makeClusters("target", "fra1", 450) })
    const client = new DigitalOceanClient("test-token", mock.url)

    const cluster = await client.findClusterByName("target")

    expect(cluster).toMatchObject({ name: "target", region: "fra1" })
    const pages = mock.requests.map((r) => r.query.page)
    expect(pages).toEqual(["1", "2", "3"])
    expect(mock.requests.every((r) => r.query.per_page === "200")).toBe(true)
  })

  it("lists available clusters when the name is not found", async () => {
    mock = await startMockApi({ clusters: makeClusters("real", "nyc1", 1) })
    const client = new DigitalOceanClient("test-token", mock.url)

    await expect(client.findClusterByName("missing")).rejects.toThrow(
      "No cluster found with name 'missing'. Clusters on this account: filler-0, real.",
    )
  })

  it("explains a rejected token", async () => {
    mock = await startMockApi()
    const client = new DigitalOceanClient("wrong-token", mock.url)

    const error = await client.listClusters().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DigitalOceanApiError)
    expect((error as DigitalOceanApiError).status).toBe(401)
    expect((error as Error).message).toMatch(/rejected the access token/)
  })

  it("gets a cluster by id", async () => {
    mock = await startMockApi()
    const client = new DigitalOceanClient("test-token", mock.url)

    await expect(client.getCluster(TARGET_CLUSTER_ID)).resolves.toEqual({
      id: TARGET_CLUSTER_ID,
      name: "e2e-cluster",
      region: "nyc1",
    })
    await expect(client.getCluster("nope")).rejects.toThrow(/404/)
  })

  it("passes the expiry when fetching credentials", async () => {
    mock = await startMockApi()
    const client = new DigitalOceanClient("test-token", mock.url)

    const credentials = await client.getCredentials(TARGET_CLUSTER_ID, 90)

    expect(credentials.token).toBe("fake-cluster-token")
    expect(mock.requests.at(-1)).toEqual({
      path: `/v2/kubernetes/clusters/${TARGET_CLUSTER_ID}/credentials`,
      query: { expiry_seconds: "90" },
    })
  })

  it("reads the base URL from DOKUBE_API_URL", async () => {
    mock = await startMockApi()
    process.env.DOKUBE_API_URL = `${mock.url}/`
    try {
      await expect(
        new DigitalOceanClient("test-token").listClusters(),
      ).resolves.toHaveLength(1)
    } finally {
      delete process.env.DOKUBE_API_URL
    }
  })
})

it("explains when the API is unreachable", async () => {
  // Grab a free port, then close it so nothing is listening there.
  const { url } = await startMockApi().then(async (m) => {
    await m.close()
    return m
  })
  const client = new DigitalOceanClient("test-token", url)
  await expect(client.listClusters()).rejects.toThrow(
    /Could not reach the DigitalOcean API at http:\/\/127\.0\.0\.1:\d+: .*ECONNREFUSED/,
  )
})

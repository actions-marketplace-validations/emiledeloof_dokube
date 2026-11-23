import { mkdtemp, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import {
  buildKubeconfig,
  detectPlatform,
  kubectlDownloadUrl,
  resolveKubectlVersion,
  sha256File,
} from "../src/kubectl.js"

describe("resolveKubectlVersion", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function stubFetch(body: string, ok = true) {
    const fetchMock = vi.fn((url: string) =>
      Promise.resolve({
        ok,
        status: ok ? 200 : 404,
        url,
        text: () => Promise.resolve(body),
      }),
    )
    vi.stubGlobal("fetch", fetchMock)
    return fetchMock
  }

  it.each([
    ["1.31.4", "1.31.4"],
    ["v1.31.4", "1.31.4"],
    ["1.32.0-rc.1", "1.32.0-rc.1"],
  ])(
    "uses exact version %s without a network call",
    async (input, expected) => {
      const fetchMock = stubFetch("unused")
      await expect(resolveKubectlVersion(input)).resolves.toBe(expected)
      expect(fetchMock).not.toHaveBeenCalled()
    },
  )

  it.each(["latest", "", "stable"])(
    "resolves %j via stable.txt",
    async (input) => {
      const fetchMock = stubFetch("v1.37.2\n")
      await expect(resolveKubectlVersion(input)).resolves.toBe("1.37.2")
      expect(fetchMock).toHaveBeenCalledWith(
        "https://dl.k8s.io/release/stable.txt",
      )
    },
  )

  it("resolves a minor version via its stable channel", async () => {
    const fetchMock = stubFetch("v1.31.9")
    await expect(resolveKubectlVersion("1.31")).resolves.toBe("1.31.9")
    expect(fetchMock).toHaveBeenCalledWith(
      "https://dl.k8s.io/release/stable-1.31.txt",
    )
  })

  it("rejects nonsense", async () => {
    await expect(resolveKubectlVersion("banana")).rejects.toThrow(
      /Invalid kubectl version/,
    )
  })

  it("reports an unknown minor version", async () => {
    stubFetch("Not found", false)
    await expect(resolveKubectlVersion("1.99")).rejects.toThrow(
      /Could not resolve/,
    )
  })
})

describe("detectPlatform", () => {
  it.each([
    [
      "linux",
      "x64",
      { system: "linux", architecture: "amd64", executable: "kubectl" },
    ],
    [
      "linux",
      "arm64",
      { system: "linux", architecture: "arm64", executable: "kubectl" },
    ],
    [
      "darwin",
      "arm64",
      { system: "darwin", architecture: "arm64", executable: "kubectl" },
    ],
    [
      "win32",
      "x64",
      { system: "windows", architecture: "amd64", executable: "kubectl.exe" },
    ],
    [
      "linux",
      "ppc64",
      { system: "linux", architecture: "ppc64le", executable: "kubectl" },
    ],
  ] as const)("maps %s/%s", (platform, arch, expected) => {
    expect(detectPlatform(platform, arch)).toEqual(expected)
  })

  it("rejects unsupported systems", () => {
    expect(() => detectPlatform("freebsd", "x64")).toThrow(/platform 'freebsd'/)
    expect(() => detectPlatform("linux", "ia32")).toThrow(/architecture 'ia32'/)
  })
})

it("builds the dl.k8s.io download URL", () => {
  expect(kubectlDownloadUrl("1.33.0", detectPlatform("win32", "x64"))).toBe(
    "https://dl.k8s.io/release/v1.33.0/bin/windows/amd64/kubectl.exe",
  )
})

it("hashes files with sha256", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dokube-test-"))
  const file = path.join(dir, "data")
  await writeFile(file, "hello")
  await expect(sha256File(file)).resolves.toBe(
    "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
  )
})

it("builds a doctl-style kubeconfig", () => {
  const config = buildKubeconfig({
    clusterName: "prod",
    region: "ams3",
    server: "https://k8s.example",
    certificateAuthorityData: "Q0E=",
    token: "secret",
    namespace: "apps",
  })
  expect(config).toEqual({
    apiVersion: "v1",
    kind: "Config",
    clusters: [
      {
        name: "do-ams3-prod",
        cluster: {
          "certificate-authority-data": "Q0E=",
          server: "https://k8s.example",
        },
      },
    ],
    contexts: [
      {
        name: "do-ams3-prod",
        context: {
          cluster: "do-ams3-prod",
          namespace: "apps",
          user: "do-ams3-prod-admin",
        },
      },
    ],
    "current-context": "do-ams3-prod",
    preferences: {},
    users: [{ name: "do-ams3-prod-admin", user: { token: "secret" } }],
  })
})

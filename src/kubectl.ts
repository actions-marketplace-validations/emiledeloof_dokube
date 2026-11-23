/**
 * kubectl version resolution, installation and kubeconfig generation.
 */

import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { chmod } from "node:fs/promises"
import os from "node:os"

import * as core from "@actions/core"
import * as tc from "@actions/tool-cache"

export const KUBECTL_RELEASE_URL = "https://dl.k8s.io/release"

const FULL_VERSION = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/
const MINOR_VERSION = /^v?(\d+\.\d+)$/
/** DigitalOcean cluster versions look like "1.33.1-do.0". */
const CLUSTER_VERSION = /^v?((\d+\.\d+)\.\d+)/

/**
 * Pick the kubectl version to install.
 *
 * With `input` "cluster" (the default) or empty, matches the cluster: the
 * newest kubectl patch release of the cluster's minor version, which is always
 * within the supported kubectl/server version skew. Anything else is resolved
 * with `resolveKubectlVersion`.
 */
export async function chooseKubectlVersion(
  input: string,
  clusterVersion: string | undefined,
): Promise<string> {
  const value = input.trim()
  if (value !== "" && value !== "cluster") return resolveKubectlVersion(value)

  const match = CLUSTER_VERSION.exec(clusterVersion ?? "")
  const exact = match?.[1]
  const minor = match?.[2]
  if (!exact || !minor) {
    core.warning(
      `Could not read the cluster's Kubernetes version ('${clusterVersion ?? ""}'); installing the latest kubectl instead.`,
    )
    return resolveKubectlVersion("latest")
  }

  core.info(
    `Cluster runs Kubernetes ${exact}; installing the newest kubectl ${minor}.x.`,
  )
  try {
    return await resolveKubectlVersion(minor)
  } catch (error) {
    core.warning(
      `${error instanceof Error ? error.message : String(error)} Falling back to kubectl ${exact}.`,
    )
    return exact
  }
}

/**
 * Resolve an explicit version to an exact kubectl version (without the "v").
 *
 * Accepts "latest", a minor version like "1.31" (resolves to its newest patch),
 * or an exact version like "1.31.4" / "v1.31.4".
 */
export async function resolveKubectlVersion(input: string): Promise<string> {
  const value = input.trim()

  const full = FULL_VERSION.exec(value)?.[1]
  if (full) return full

  let channel: string
  const minor = MINOR_VERSION.exec(value)?.[1]
  if (value === "latest" || value === "stable") {
    channel = "stable"
  } else if (minor) {
    channel = `stable-${minor}`
  } else {
    throw new Error(
      `Invalid kubectl version '${input}'. Use "cluster", "latest", a minor version like "1.31", or an exact version like "1.31.4".`,
    )
  }

  const response = await fetch(`${KUBECTL_RELEASE_URL}/${channel}.txt`)
  if (!response.ok) {
    throw new Error(
      `Could not resolve kubectl version '${input}' (${response.status} from ${response.url}).`,
    )
  }
  const resolved = FULL_VERSION.exec((await response.text()).trim())?.[1]
  if (!resolved) {
    throw new Error(`Unexpected response resolving kubectl version '${input}'.`)
  }
  return resolved
}

export interface Platform {
  system: "linux" | "darwin" | "windows"
  architecture: string
  executable: string
}

const ARCHITECTURES: Record<string, string> = {
  x64: "amd64",
  arm64: "arm64",
  arm: "arm",
  s390x: "s390x",
  ppc64: "ppc64le",
}

export function detectPlatform(
  platform: NodeJS.Platform = os.platform(),
  arch: string = os.arch(),
): Platform {
  const architecture = ARCHITECTURES[arch]
  if (!architecture) {
    throw new Error(`kubectl is not published for CPU architecture '${arch}'.`)
  }
  switch (platform) {
    case "linux":
    case "darwin":
      return { system: platform, architecture, executable: "kubectl" }
    case "win32":
      return { system: "windows", architecture, executable: "kubectl.exe" }
    default:
      throw new Error(`kubectl is not published for platform '${platform}'.`)
  }
}

export function kubectlDownloadUrl(
  version: string,
  platform: Platform,
): string {
  return `${KUBECTL_RELEASE_URL}/v${version}/bin/${platform.system}/${platform.architecture}/${platform.executable}`
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest("hex")
}

/**
 * Download (or reuse from the tool cache) a checksum-verified kubectl binary.
 *
 * @returns The directory containing the kubectl executable.
 */
export async function installKubectl(
  version: string,
  platform: Platform = detectPlatform(),
): Promise<string> {
  const cached = tc.find("kubectl", version, platform.architecture)
  if (cached) {
    core.info(`Using cached kubectl ${version}.`)
    return cached
  }

  const url = kubectlDownloadUrl(version, platform)
  core.info(`Downloading kubectl from ${url}`)
  const binary = await tc.downloadTool(url)

  const checksumResponse = await fetch(`${url}.sha256`)
  if (!checksumResponse.ok) {
    throw new Error(
      `Could not download kubectl checksum (${checksumResponse.status} from ${url}.sha256).`,
    )
  }
  const expected = (await checksumResponse.text()).trim().split(/\s+/)[0] ?? ""
  const actual = await sha256File(binary)
  if (expected.toLowerCase() !== actual) {
    throw new Error(
      `kubectl checksum mismatch: expected ${expected}, got ${actual}.`,
    )
  }
  core.info("Checksum verified.")

  await chmod(binary, 0o755)
  return tc.cacheFile(
    binary,
    platform.executable,
    "kubectl",
    version,
    platform.architecture,
  )
}

export interface KubeconfigInput {
  clusterName: string
  region: string
  server: string
  certificateAuthorityData: string
  token: string
  namespace: string
}

/** Build a kubeconfig using the same naming scheme as `doctl`. */
export function buildKubeconfig({
  clusterName,
  region,
  server,
  certificateAuthorityData,
  token,
  namespace,
}: KubeconfigInput) {
  const name = `do-${region}-${clusterName}`
  const user = `${name}-admin`
  return {
    apiVersion: "v1",
    kind: "Config",
    clusters: [
      {
        name,
        cluster: {
          "certificate-authority-data": certificateAuthorityData,
          server,
        },
      },
    ],
    contexts: [{ name, context: { cluster: name, namespace, user } }],
    "current-context": name,
    preferences: {},
    users: [{ name: user, user: { token } }],
  }
}

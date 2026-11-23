#!/usr/bin/env node
/**
 * End-to-end test of the built action (dist/index.js) without DigitalOcean.
 *
 * Runs the action the way the GitHub runner does (INPUT_* env vars and
 * GITHUB_ENV / GITHUB_PATH / GITHUB_OUTPUT files) against the mock
 * DigitalOcean API in test/mock-do-api.mjs.
 *
 *   npm run e2e          mock API only: checks the kubeconfig, the outputs and
 *                        that the downloaded kubectl runs
 *   npm run e2e:kind     also creates a local kind cluster (needs kind + docker
 *                        or podman) and runs `kubectl get nodes` through the
 *                        kubeconfig the action wrote
 *
 * Flags: --kind, --keep (don't delete the kind cluster afterwards)
 * Env:   E2E_KUBECTL_VERSION (default "latest")
 */

import { execFileSync, spawn, spawnSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { randomUUID } from "node:crypto"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  TARGET_CLUSTER_ID,
  makeClusters,
  startMockApi,
} from "../test/mock-do-api.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const args = new Set(process.argv.slice(2))
const useKind = args.has("--kind")
const keep = args.has("--keep")
const kindCluster = "dokube-e2e"
const kindContext = `kind-${kindCluster}`

const ACCESS_TOKEN = "e2e-access-token"
const CLUSTER_NAME = "e2e-cluster"

function step(message) {
  console.log(`\n\x1b[1m▶ ${message}\x1b[0m`)
}

function fail(message) {
  console.error(`\n\x1b[31m✘ ${message}\x1b[0m`)
  process.exitCode = 1
  throw new Error(message)
}

function run(command, commandArgs, options = {}) {
  return execFileSync(command, commandArgs, {
    encoding: "utf8",
    ...options,
  }).trim()
}

function commandExists(command) {
  return (
    spawnSync(command, ["version"], { stdio: "ignore" }).error === undefined
  )
}

/** Parse the GITHUB_OUTPUT / GITHUB_ENV heredoc format written by @actions/core. */
function parseCommandFile(file) {
  const result = {}
  const lines = readFileSync(file, "utf8").split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const match = /^([^<=]+)<<(.+)$/.exec(lines[i])
    if (!match) continue
    const [, name, delimiter] = match
    const value = []
    while (++i < lines.length && lines[i] !== delimiter) value.push(lines[i])
    result[name] = value.join("\n")
  }
  return result
}

/** Get API server details and a ServiceAccount token for the kind cluster. */
function prepareKindCluster() {
  if (!commandExists("kind"))
    fail(
      "kind is not installed. See https://kind.sigs.k8s.io/docs/user/quick-start/#installation",
    )
  if (!commandExists("kubectl"))
    fail("--kind needs a kubectl on PATH to set the cluster up.")

  let created = false
  if (!run("kind", ["get", "clusters"]).split("\n").includes(kindCluster)) {
    step(`Creating kind cluster '${kindCluster}'`)
    run(
      "kind",
      ["create", "cluster", "--name", kindCluster, "--wait", "120s"],
      { stdio: "inherit" },
    )
    created = true
  }

  const kubectl = (...kubectlArgs) =>
    run("kubectl", ["--context", kindContext, ...kubectlArgs])
  const config = JSON.parse(
    kubectl("config", "view", "--raw", "--minify", "-o", "json"),
  )
  const cluster = config.clusters[0].cluster

  // Like a DigitalOcean cluster, hand out a bearer token rather than client certs.
  execFileSync("kubectl", ["--context", kindContext, "apply", "-f", "-"], {
    input: JSON.stringify({
      apiVersion: "v1",
      kind: "List",
      items: [
        {
          apiVersion: "v1",
          kind: "ServiceAccount",
          metadata: { name: "dokube-e2e", namespace: "default" },
        },
        {
          apiVersion: "rbac.authorization.k8s.io/v1",
          kind: "ClusterRoleBinding",
          metadata: { name: "dokube-e2e" },
          roleRef: {
            apiGroup: "rbac.authorization.k8s.io",
            kind: "ClusterRole",
            name: "cluster-admin",
          },
          subjects: [
            {
              kind: "ServiceAccount",
              name: "dokube-e2e",
              namespace: "default",
            },
          ],
        },
      ],
    }),
    stdio: ["pipe", "inherit", "inherit"],
  })
  const token = kubectl(
    "create",
    "token",
    "dokube-e2e",
    "-n",
    "default",
    "--duration",
    "10m",
  )

  return {
    created,
    credentials: {
      server: cluster.server,
      certificate_authority_data: cluster["certificate-authority-data"],
      token,
    },
  }
}

/**
 * Run dist/index.js as a child process. This must be async: the mock API lives
 * in this process, so a blocking spawn would stop it from answering.
 */
async function runAction(mockUrl, workdir, inputs) {
  const files = {}
  for (const name of ["GITHUB_ENV", "GITHUB_PATH", "GITHUB_OUTPUT"]) {
    files[name] = path.join(workdir, name)
    writeFileSync(files[name], "")
  }
  const inputEnv = Object.fromEntries(
    Object.entries(inputs).map(([name, value]) => [
      `INPUT_${name.toUpperCase()}`,
      value,
    ]),
  )
  const toolCache = path.join(os.tmpdir(), "dokube-e2e-tool-cache")
  mkdirSync(toolCache, { recursive: true })

  const child = spawn(process.execPath, [path.join(root, "dist", "index.js")], {
    env: {
      ...process.env,
      ...inputEnv,
      ...files,
      DOKUBE_API_URL: mockUrl,
      RUNNER_TEMP: workdir,
      RUNNER_TOOL_CACHE: toolCache,
      KUBECONFIG: "",
    },
  })
  // On GitHub Actions, stop the runner from acting on the child's workflow
  // commands (e.g. turning the expected "No cluster found" into an annotation).
  const stopToken = randomUUID()
  const inActions = process.env.GITHUB_ACTIONS === "true"
  if (inActions) console.log(`::stop-commands::${stopToken}`)

  let stdout = ""
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    stdout += chunk
    process.stdout.write(chunk.replace(/^(?=.)/gm, "    "))
  })
  child.stderr.pipe(process.stderr)
  const status = await new Promise((resolve, reject) => {
    child.on("error", reject)
    child.on("close", resolve)
  })
  if (inActions) console.log(`::${stopToken}::`)
  return { status, stdout, files }
}

async function main() {
  if (!existsSync(path.join(root, "dist", "index.js")))
    fail("dist/index.js not found. Run `npm run build` first.")

  const kind = useKind ? prepareKindCluster() : undefined
  const mock = await startMockApi({
    accessToken: ACCESS_TOKEN,
    clusters: makeClusters(CLUSTER_NAME, "nyc1", 250),
    credentials: kind?.credentials,
  })
  const workdir = mkdtempSync(path.join(os.tmpdir(), "dokube-e2e-"))

  try {
    step("Action fails clearly for an unknown cluster")
    const bad = await runAction(mock.url, workdir, {
      personalAccessToken: ACCESS_TOKEN,
      clusterName: "does-not-exist",
    })
    if (bad.status === 0)
      fail("Expected the action to fail for an unknown cluster.")
    if (!bad.stdout.includes("No cluster found with name 'does-not-exist'"))
      fail("Missing 'No cluster found' error.")

    step("Action succeeds against the mock API")
    const { status, stdout, files } = await runAction(mock.url, workdir, {
      personalAccessToken: ACCESS_TOKEN,
      clusterName: CLUSTER_NAME,
      expirationTime: "300",
      namespace: "default",
      version: process.env.E2E_KUBECTL_VERSION ?? "latest",
    })
    if (status !== 0) fail(`Action exited with ${status}.`)

    step("Checking results")
    const outputs = parseCommandFile(files.GITHUB_OUTPUT)
    const exported = parseCommandFile(files.GITHUB_ENV)
    const kubectlDir = readFileSync(files.GITHUB_PATH, "utf8")
      .trim()
      .split(/\r?\n/)
      .at(-1)
    console.log("  outputs:", outputs)

    if (exported.KUBECONFIG !== outputs.kubeconfig)
      fail("KUBECONFIG env does not match the kubeconfig output.")
    if (!outputs.kubeconfig.startsWith(workdir))
      fail("kubeconfig was not written under RUNNER_TEMP.")
    if (
      process.platform !== "win32" &&
      (statSync(outputs.kubeconfig).mode & 0o777) !== 0o600
    ) {
      fail("kubeconfig is not mode 0600.")
    }
    if (outputs["cluster-id"] !== TARGET_CLUSTER_ID)
      fail("Unexpected cluster-id output.")

    const pages = mock.requests.filter(
      (r) => r.path === "/v2/kubernetes/clusters",
    ).length
    if (pages < 2) fail("Expected the action to page through the cluster list.")
    const credentialRequest = mock.requests.find((r) =>
      r.path.endsWith("/credentials"),
    )
    if (credentialRequest?.query.expiry_seconds !== "300")
      fail("expirationTime was not passed to the API.")

    const clusterToken = kind?.credentials.token ?? "fake-cluster-token"
    const logWithoutMasks = stdout
      .split(/\r?\n/)
      .filter((line) => !line.startsWith("::add-mask::"))
      .join("\n")
    if (logWithoutMasks.includes(clusterToken))
      fail("The cluster token leaked into the log.")
    if (!stdout.includes(`::add-mask::${clusterToken}`))
      fail("The cluster token was not masked.")

    const exe = path.join(
      kubectlDir,
      process.platform === "win32" ? "kubectl.exe" : "kubectl",
    )
    const env = { ...process.env, KUBECONFIG: outputs.kubeconfig }
    const kubectl = (...kubectlArgs) => run(exe, kubectlArgs, { env })

    const clientVersion = JSON.parse(
      kubectl("version", "--client", "-o", "json"),
    ).clientVersion.gitVersion
    console.log(`  kubectl client: ${clientVersion}`)
    if (clientVersion !== `v${outputs["kubectl-version"]}`)
      fail("Installed kubectl doesn't match kubectl-version output.")

    const context = kubectl("config", "current-context")
    console.log(`  current context: ${context}`)
    if (context !== `do-nyc1-${CLUSTER_NAME}`)
      fail("Unexpected kubeconfig context.")

    if (kind) {
      step("Talking to the kind cluster through the generated kubeconfig")
      console.log(kubectl("get", "nodes", "-o", "wide"))
    }

    console.log(
      `\n\x1b[32m✔ e2e passed${kind ? " (with kind cluster)" : ""}\x1b[0m`,
    )
  } finally {
    await mock.close()
    if (kind?.created && !keep) {
      step(`Deleting kind cluster '${kindCluster}' (pass --keep to keep it)`)
      run("kind", ["delete", "cluster", "--name", kindCluster], {
        stdio: "inherit",
      })
    }
  }
}

main().catch((error) => {
  if (!process.exitCode) console.error(error)
  process.exitCode = 1
})

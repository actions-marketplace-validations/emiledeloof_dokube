/**
 * Main action runner.
 */

import { chmod, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import * as core from "@actions/core"
import * as io from "@actions/io"

import { DigitalOceanClient } from "./digitalocean.js"
import { getInputs } from "./inputs.js"
import {
  buildKubeconfig,
  installKubectl,
  resolveKubectlVersion,
} from "./kubectl.js"

export async function run(): Promise<void> {
  try {
    const inputs = getInputs()
    const client = new DigitalOceanClient(inputs.accessToken)

    const cluster = await core.group("Finding cluster", () =>
      inputs.clusterId
        ? client.getCluster(inputs.clusterId)
        : client.findClusterByName(inputs.clusterName),
    )
    core.info(`Using cluster '${cluster.name}' (${cluster.id}).`)

    const credentials = await core.group("Fetching cluster credentials", () =>
      client.getCredentials(cluster.id, inputs.expirySeconds),
    )
    core.setSecret(credentials.token)

    const kubeconfigPath = await core.group("Writing kubeconfig", async () => {
      const dir = path.join(process.env.RUNNER_TEMP || os.tmpdir(), "dokube")
      await io.mkdirP(dir)
      const file = path.join(dir, "kubeconfig")
      const kubeconfig = buildKubeconfig({
        clusterName: cluster.name,
        region: cluster.region,
        server: credentials.server,
        certificateAuthorityData: credentials.certificate_authority_data,
        token: credentials.token,
        namespace: inputs.namespace,
      })
      await writeFile(file, JSON.stringify(kubeconfig, null, 2), {
        mode: 0o600,
      })
      // `mode` only applies when the file is created; enforce it on reruns too.
      await chmod(file, 0o600)
      core.exportVariable("KUBECONFIG", file)
      core.info(`Wrote ${file} and set it as KUBECONFIG.`)
      return file
    })

    const kubectlVersion = await core.group("Installing kubectl", async () => {
      const version = await resolveKubectlVersion(inputs.version)
      core.info(`Using kubectl ${version}.`)
      core.addPath(await installKubectl(version))
      return version
    })

    core.setOutput("kubeconfig", kubeconfigPath)
    core.setOutput("cluster-id", cluster.id)
    core.setOutput("kubectl-version", kubectlVersion)
  } catch (error) {
    core.setFailed(error instanceof Error ? error.message : String(error))
  }
}

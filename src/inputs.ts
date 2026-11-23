/**
 * Read and validate the action inputs.
 */

import * as core from "@actions/core"

export interface Inputs {
  accessToken: string
  clusterName: string
  clusterId: string
  expirySeconds: number
  namespace: string
  version: string
}

export function getInputs(): Inputs {
  const accessToken = core.getInput("personalAccessToken", { required: true })
  core.setSecret(accessToken)

  const clusterName = core.getInput("clusterName")
  const clusterId = core.getInput("clusterId")
  if (!clusterName && !clusterId) {
    throw new Error("Either clusterName or clusterId must be provided.")
  }

  const rawExpiry = core.getInput("expirationTime") || "600"
  if (!/^\d+$/.test(rawExpiry) || Number(rawExpiry) <= 0) {
    throw new Error(
      `expirationTime must be a positive whole number of seconds, got '${rawExpiry}'.`,
    )
  }

  return {
    accessToken,
    clusterName,
    clusterId,
    expirySeconds: Number(rawExpiry),
    namespace: core.getInput("namespace") || "default",
    version: core.getInput("version") || "cluster",
  }
}

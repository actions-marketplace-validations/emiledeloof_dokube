import { afterEach, describe, expect, it, vi } from "vitest"

import { getInputs } from "../src/inputs.js"

function setInputs(inputs: Record<string, string>) {
  for (const [name, value] of Object.entries(inputs)) {
    vi.stubEnv(`INPUT_${name.toUpperCase()}`, value)
  }
}

describe("getInputs", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("applies defaults", () => {
    setInputs({ personalAccessToken: "tok", clusterName: "c" })
    expect(getInputs()).toEqual({
      accessToken: "tok",
      clusterName: "c",
      clusterId: "",
      expirySeconds: 600,
      namespace: "default",
      version: "latest",
    })
  })

  it("accepts a cluster id instead of a name", () => {
    setInputs({ personalAccessToken: "tok", clusterId: "abc" })
    expect(getInputs()).toMatchObject({ clusterId: "abc", clusterName: "" })
  })

  it("requires a token", () => {
    setInputs({ clusterName: "c" })
    expect(() => getInputs()).toThrow(/personalAccessToken/)
  })

  it("requires a cluster name or id", () => {
    setInputs({ personalAccessToken: "tok" })
    expect(() => getInputs()).toThrow(/clusterName or clusterId/)
  })

  it.each(["abc", "-5", "0", "1.5"])("rejects expirationTime %j", (value) => {
    setInputs({
      personalAccessToken: "tok",
      clusterName: "c",
      expirationTime: value,
    })
    expect(() => getInputs()).toThrow(/expirationTime/)
  })
})

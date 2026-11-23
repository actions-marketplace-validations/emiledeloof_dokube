# DigitalOcean Kubernetes GitHub Action

Fetches the config for your DigitalOcean Kubernetes Cluster, then installs and configures `kubectl`, exposing it to path for future use!

This is a maintained fork of [matootie/dokube](https://github.com/matootie/dokube).

### Upgrading from v1

v2 is a rewrite with a few breaking changes:

- `version` now defaults to `latest` instead of an old pinned kubectl. Set it to your cluster's minor version (e.g. `"1.31"`) if you need to match it.
- kubectl is downloaded from `dl.k8s.io`, since the old download location no longer gets new releases.
- The action runs on Node 24.
- `clusterName` is optional if you pass the new `clusterId` input.

See the [releases](https://github.com/emiledeloof/dokube/releases) for the full changelog.

## Runs on

| Type                | Systems                                                                 | Note                                                               |
| :------------------ | :---------------------------------------------------------------------- | :----------------------------------------------------------------- |
| GitHub Runners      | `ubuntu-latest`, `macos-latest`, `windows-latest`                       | _Tested in CI on every push._                                      |
| Self-Hosted Runners | Linux, macOS and Windows on `amd64`, `arm64`, `arm`, `s390x`, `ppc64le` | _Should work anywhere kubectl publishes a binary for your system._ |

## Inputs

| Name                  | Requirement    | Description                                                                                                                                                                                                                                     |
| :-------------------- | :------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `personalAccessToken` | **Required**   | A DigitalOcean [Personal Access Token](https://docs.digitalocean.com/reference/api/create-personal-access-token/) on the same account as the cluster. Needs the `kubernetes:read` and `kubernetes:access_cluster` scopes.                       |
| `clusterName`         | **_Optional_** | The name of the cluster to operate on. Either `clusterName` or `clusterId` is required.                                                                                                                                                         |
| `clusterId`           | **_Optional_** | The ID of the cluster. Skips looking the cluster up by name.                                                                                                                                                                                    |
| `version`             | **_Optional_** | The kubectl version: `latest` (default), a minor version like `1.31` (installs its newest patch release), or an exact version like `1.31.4`. Pick one within one minor version of your cluster. _See [example](#specifying-a-kubectl-version)._ |
| `expirationTime`      | **_Optional_** | How long, in seconds, the generated cluster credentials stay valid. Should be slightly longer than your job. Defaults to `600`. _See [example](#specifying-a-custom-expiration-time)._                                                          |
| `namespace`           | **_Optional_** | The Kubernetes namespace to operate under. Defaults to `default`.                                                                                                                                                                               |

## Outputs

| Name              | Description                                                      |
| :---------------- | :--------------------------------------------------------------- |
| `kubeconfig`      | Path to the generated kubeconfig. Also exported as `KUBECONFIG`. |
| `cluster-id`      | The ID of the cluster.                                           |
| `kubectl-version` | The exact kubectl version that was installed, e.g. `1.37.2`.     |

## Example usage

### Simple, minimal usage

```yaml
# Set up the Kubernetes CLI with your DigitalOcean Kubernetes cluster.
- name: Set up kubectl
  uses: emiledeloof/dokube@v2
  with:
    personalAccessToken: ${{ secrets.DIGITALOCEAN_TOKEN }}
    clusterName: my-fabulous-cluster

# Run any kubectl commands you want!
- name: Get nodes
  run: kubectl get nodes
```

This sets up `kubectl` configured for your DigitalOcean Kubernetes cluster. After that you're free to use `kubectl` as you wish. Tools that read `KUBECONFIG` (Helm, kustomize, etc.) pick it up too.

### Specifying a kubectl version

```yaml
- name: Set up kubectl
  uses: emiledeloof/dokube@v2
  with:
    personalAccessToken: ${{ secrets.DIGITALOCEAN_TOKEN }}
    clusterName: my-fabulous-cluster
    version: "1.31"
```

kubectl supports clusters one minor version older or newer than itself, so match this to your cluster's version.

### Specifying a custom expiration time

```yaml
- name: Set up kubectl
  uses: emiledeloof/dokube@v2
  with:
    personalAccessToken: ${{ secrets.DIGITALOCEAN_TOKEN }}
    clusterName: my-fabulous-cluster
    expirationTime: "1200"
```

The generated credentials only last a short time, since they are only meant to be used for the duration of the job.

### Using the outputs

```yaml
- name: Set up kubectl
  id: dokube
  uses: emiledeloof/dokube@v2
  with:
    personalAccessToken: ${{ secrets.DIGITALOCEAN_TOKEN }}
    clusterName: my-fabulous-cluster

- run: echo "Installed kubectl ${{ steps.dokube.outputs.kubectl-version }} for cluster ${{ steps.dokube.outputs.cluster-id }}"
```

## Development

The action is written in TypeScript in `src/` and bundled into `dist/index.js` with [ncc](https://github.com/vercel/ncc). GitHub runs `dist/index.js` directly, so **commit the rebuilt `dist/` with every source change** (CI fails if you forget).

```sh
npm ci
npm run all        # format check, lint, typecheck, unit tests, build
```

| Script              | What it does                                                             |
| :------------------ | :----------------------------------------------------------------------- |
| `npm run build`     | Bundle `src/` into `dist/`.                                              |
| `npm test`          | Unit tests (vitest).                                                     |
| `npm run lint`      | ESLint.                                                                  |
| `npm run typecheck` | `tsc --noEmit`.                                                          |
| `npm run format`    | Prettier.                                                                |
| `npm run e2e`       | Build, then run the action end to end against a mock API.                |
| `npm run e2e:kind`  | Same, but against a real local [kind](https://kind.sigs.k8s.io) cluster. |
| `npm run mock-api`  | Start the mock DigitalOcean API on its own.                              |

### Testing without DigitalOcean

`test/mock-do-api.mjs` is a small fake of the DigitalOcean Kubernetes API (cluster listing with pagination, cluster lookup, credentials). The action talks to it instead of DigitalOcean when `DOKUBE_API_URL` is set.

- **`npm run e2e`** runs `dist/index.js` the way a GitHub runner would (`INPUT_*` variables, `GITHUB_ENV`/`GITHUB_PATH`/`GITHUB_OUTPUT` files) against the mock. It checks the outputs, the kubeconfig and its permissions, that the token is masked, and that the downloaded kubectl runs. It needs internet access to download kubectl, but no cluster.
- **`npm run e2e:kind`** also creates a kind cluster called `dokube-e2e` (needs [kind](https://kind.sigs.k8s.io/docs/user/quick-start/#installation) and Docker or Podman). It makes the mock hand out a ServiceAccount token for it, like DigitalOcean does, then runs `kubectl get nodes` through the kubeconfig the action wrote. It deletes the cluster afterwards unless you pass `-- --keep`, and it reuses an existing `dokube-e2e` cluster without deleting it.

To try it by hand in your own workflow or with [act](https://github.com/nektos/act), start the mock and point the action at it:

```sh
MOCK_K8S_SERVER=https://127.0.0.1:6443 MOCK_K8S_TOKEN=... npm run mock-api
```

```yaml
- uses: ./
  env:
    DOKUBE_API_URL: http://127.0.0.1:8787/v2
  with:
    personalAccessToken: test-token
    clusterName: e2e-cluster
```

The other `MOCK_*` settings are documented at the top of `test/mock-do-api.mjs`.

### CI

- **CI** (`ci.yml`): lint, typecheck, unit tests, and a check that `dist/` matches `src/`.
- **E2E** (`e2e.yml`): runs the action via `uses: ./` against the mock API on Linux and macOS, runs `npm run e2e` on Windows, and runs the kind test.
- **Integration** (`integration-digitalocean.yml`): runs against a real cluster when the `DIGITALOCEAN_TOKEN` and `CLUSTER_NAME` secrets are set; skipped otherwise. Run it manually from the Actions tab.

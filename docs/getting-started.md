# Getting started

## Install

```sh
bun add pve-agent
```

Or from a checkout:

```sh
git clone https://github.com/paltaio/pve-agent.git
cd pve-agent
bun install
bun test
```

The library runs on Bun and ships TypeScript source that uses Bun's `fetch`,
`WebSocket` and `spawn`, so the consuming project's `tsconfig.json` needs the
Bun types:

```json
{ "compilerOptions": { "types": ["bun"] } }
```

`@types/bun` is a peer dependency, installed alongside the package.

## Credentials

Eight variables. `PVE_HOST` and one credential pair, token or user and
password, are required; the rest are optional:

| Variable | Meaning |
| --- | --- |
| `PVE_HOST` | Node address the client talks to |
| `PVE_PORT` | Defaults to 8006 |
| `PVE_VERIFY_SSL` | Defaults to on; `0`, `false`, `no` or `off` turn TLS verification off |
| `PVE_NODE` | Node used when a call does not name one |
| `PVE_TOKEN_ID` | `user@realm!name`, or a bare name when `PVE_USER` is set |
| `PVE_TOKEN_SECRET` | The token's secret |
| `PVE_USER` | Login user for the ticket tier, such as `root@pam` |
| `PVE_PASSWORD` | That user's password |

They resolve in this order: explicit arguments to `connect`, then
`process.env`, then a shell-style env file. The file is `envFile` if you pass
one, otherwise `PVE_ENV_FILE`, otherwise `./pve.env` in the working directory.
A line may start with `export `, and a value may be quoted.

```sh
# pve.env
export PVE_HOST=192.0.2.10
export PVE_NODE=pve1
export PVE_TOKEN_ID=automation@pve!ci
export PVE_TOKEN_SECRET=1a2b3c4d-...
export PVE_USER=root@pam
export PVE_PASSWORD=...
```

A node with a self-signed certificate fails verification. Turning it off with
`PVE_VERIFY_SSL=0` lets anyone on the path present their own certificate and
read the credentials; the fix that keeps verification is to trust the node's
certificate, or the CA that signed it, through `NODE_EXTRA_CA_CERTS` or the
system trust store, or to issue the node a certificate from a CA the client
already trusts.

Configure both a token and a ticket when you can. The client holds both and
picks per call, so an ordinary read goes out on the token and a call that
needs `root@pam` escalates on its own. See [auth.md](auth.md).

For the shell layer, authorise a key for root on each node:

```sh
ssh-copy-id root@192.0.2.10
```

## Connect

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()
```

`connect()` sends one `GET /version` to check the credentials, and closes the
cluster again when that call fails. It takes the credential fields above plus
a request timeout, a trace hook and the shell settings:

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect({
	host: '192.0.2.10',
	node: 'pve1',
	envFile: './clusters/lab.env',
	timeoutMs: 30_000,
	onRequest: (trace) => console.error(`${trace.decision.tier} ${trace.method} ${trace.path}`),
	shell: {
		ssh: { identityFile: '/home/me/.ssh/pve' },
		policy: { destructive: 'refuse' },
	},
})
```

`close()` disconnects every VNC session, serial console and node shell the
cluster opened, then drops the cached ticket. It is safe to call twice.
`await using` calls it when the scope ends, including on a throw; without it,
use `try`/`finally`.

Two clusters in one process share nothing: separate clients, separate
websockets, separate node shells.

## Reading the cluster

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()

const version = await cluster.version()
// { version: '9.2.11', release: '9.2', repoid: '3b7c1d9e5f2a8046' }

for (const node of await cluster.nodes()) {
	console.log(node.node, node.status, node.uptime)
}

for (const guest of await cluster.list({ status: 'running' })) {
	console.log(guest.vmid, guest.type, guest.node, guest.name)
}
```

`cluster.list()` filters on `type`, `node`, `status`, `tag` and
`excludeTemplates`. It is one `GET /cluster/resources`, which answers from the
cache pvestatd refreshes every few seconds: a guest created a moment ago can
still appear with `status: 'unknown'`. Read the guest's own status when the
answer has to be current.

## Handles

A handle is a value object. Making one sends nothing.

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()

const vm = cluster.vm(100) // node defaults to PVE_NODE
const vm2 = cluster.vm(101, 'pve2')
const ct = cluster.container(110, 'pve3')
const node = cluster.node('pve1')
```

When you know the vmid but not the node or the type, `cluster.guest(vmid)`
costs one lookup and returns whichever type it found:

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()

const guest = await cluster.guest(110)
if (guest.type === 'qemu') await guest.kvm.press('enter')
else console.log(await guest.exec('df -h'))
```

Most node endpoints carry `proxyTo: 'node'`, so whichever node the client
talks to forwards the call to the named one. One client covers the cluster.
The exception is a node that is not a member yet, which nothing can forward
to; that needs its own client, built with `PveClient.fromEnv({ host })`.

## Creating a guest

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()
const required = (name: string): string => {
	const value = process.env[name]
	if (!value) throw new Error(`${name} is not set`)
	return value
}

const vm = await cluster.createVm({
	name: 'demo',
	memory: '2048',
	cores: 2,
	ostype: 'l26',
	scsihw: 'virtio-scsi-single',
	scsi0: 'local-zfs:16',
	net0: 'virtio,bridge=vmbr0',
})

const ct = await cluster.createContainer({
	hostname: 'demo',
	ostemplate: 'local:vztmpl/debian-13-standard_13.0-1_amd64.tar.zst',
	rootfs: 'local-zfs:8',
	memory: 512,
	net0: 'name=eth0,bridge=vmbr0,ip=dhcp',
	password: required('CT_PASSWORD'),
	start: true,
})
```

Both claim the lowest free vmid unless you pass one, wait for the create
task, and return a handle. Disks are config keys:
`scsi0: 'local-zfs:16'` allocates 16 GiB. QEMU takes `memory` as a string and
LXC as a number, as the schema declares them. See [guests.md](guests.md).

## Falling through to the client

Anything without a wrapper goes through `cluster.client`, which takes a
concrete path below `/api2/json` and returns the response's `data` field:

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()

const config = await cluster.client.get<Record<string, string>>(
	'/nodes/pve1/qemu/100/config',
)
const upid = await cluster.client.post<string>('/nodes/pve1/qemu/100/status/start')
await cluster.client.waitForTask(upid)
```

Every call is matched against the generated registry, which gives the client
the parameter metadata and the privilege flags. A path that is not in the
registry throws `PveConfigError`, which catches typos; pass
`{ allowUnknownEndpoint: true }` to send it anyway.

## Running a script

```sh
PVE_ENV_FILE=./pve.env bun run script.ts
```

For a few lines, skip the file:

```sh
PVE_ENV_FILE=./pve.env bun -e 'import pve from "pve-agent"; await using c = await pve.connect(); console.log(await c.nodes())'
```

## Next

- [Authentication tiers](auth.md) if a call comes back 403 or throws
  `PveTierError`
- [Guests](guests.md) for the guest surface in full
- [What the API cannot do](api-gaps.md) before you go looking for an endpoint
  that is not there

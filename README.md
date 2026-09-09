# pve-agent

A TypeScript library for driving a Proxmox VE cluster from Bun. It covers the
REST API through a generated registry of 537 endpoints, QEMU and LXC guests,
the VNC and serial consoles, the QEMU guest agent, and a root shell on each
node for the work the API has no endpoint for.

- 537 endpoints from a PVE 9.2 schema, each with typed parameters and its
  privilege flags
- QEMU and LXC guests behind one handle: lifecycle, config, snapshots, cloning,
  migration, firewall
- Keyboard, mouse and framebuffer over VNC; screenshots as JPEG or PNG; pixel,
  colour and change matchers for waiting on a screen
- Serial consoles rendered through a headless terminal, with login and prompt
  detection
- Commands inside a guest through the QEMU guest agent or `pct exec`, with
  Linux, macOS and Windows helpers
- A root shell on any node over SSH or the termproxy websocket, with ZFS,
  systemd, apt, `qm` and `pct` helpers and a policy that refuses destructive
  commands
- Property-string parsing and formatting driven by the same schema the
  registry is generated from

Bun only.

## Install

```sh
bun add pve-agent
```

The package ships TypeScript source and uses Bun's `fetch`, `WebSocket` and
`spawn`, so a consumer's `tsconfig.json` needs `"types": ["bun"]`; see
[docs/getting-started.md](docs/getting-started.md).

From a checkout:

```sh
git clone https://github.com/paltaio/pve-agent.git
cd pve-agent
bun install
bun test
```

## Credentials

Put them in the environment, or in a `pve.env` file:

```sh
PVE_HOST=192.0.2.10
PVE_PORT=8006
PVE_NODE=pve1

# API token: reaches every endpoint except seventeen
PVE_TOKEN_ID=automation@pve!ci
PVE_TOKEN_SECRET=...

# root@pam ticket: the twelve root-only endpoints, the root-only parameters,
# and the termproxy shell
PVE_USER=root@pam
PVE_PASSWORD=...
```

The client picks the credential per call: the token first, the ticket for the
endpoints that refuse a token, and a `root@pam` ticket for the endpoints and
parameters whose handlers compare the caller against that name.
[docs/getting-started.md](docs/getting-started.md) has the resolution order
and every variable, including `PVE_VERIFY_SSL`; [docs/auth.md](docs/auth.md)
has the tiers.

The shell layer uses SSH as root with key authentication, or the termproxy
websocket with a `root@pam` ticket:

```sh
ssh-copy-id root@192.0.2.10
```

## First script

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()

const version = await cluster.version()
console.log(`pve-manager ${version.version}`)

for (const guest of await cluster.list()) {
	console.log(`${guest.vmid} ${guest.type} ${guest.node} ${guest.name} ${guest.status}`)
}
```

```sh
PVE_ENV_FILE=./pve.env bun run status.ts
```

Creating a VM, booting it and reading its screen:

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect({ node: 'pve1' })

const vm = await cluster.createVm({
	name: 'demo',
	memory: '2048',
	cores: 2,
	ostype: 'l26',
	scsihw: 'virtio-scsi-single',
	scsi0: 'local-zfs:16',
	net0: 'virtio,bridge=vmbr0',
})

await vm.start()
await vm.waitFor('running')

await vm.kvm.press('shift')
await vm.kvm.waitForScreen((frame) => frame.width > 640, { timeoutMs: 10_000 })
const shot = await vm.kvm.screenshot({ format: 'png' })
await Bun.write('demo.png', shot.data)

await vm.stop()
await vm.delete({ purge: true })
```

## The shape of the API

`pve.connect()` sends one `GET /version` and returns a `PveCluster`. Every
node, guest and console handle hangs off it, and one `close()` tears down every
socket and shell the cluster opened; `await using` calls it when the scope
ends.

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()

await cluster.nodes() // every node with status and resource totals
await cluster.list() // every guest, both types, sorted by vmid
cluster.vm(100) // PveVm on PVE_NODE; cluster.vm(100, 'pve2') names the node
cluster.container(110) // PveContainer, same rule
await cluster.guest(100) // finds node and type with one GET /cluster/resources
cluster.node('pve1') // PveNode; cluster.node() is PVE_NODE
await cluster.createVm({ memory: '2048', scsi0: 'local-zfs:16' }) // waits for the create task
cluster.api // ClusterApi: status, resources, ha, backup, firewall, pools, storage, replication
cluster.access // AccessApi: users, groups, roles, ACLs, tokens, realms, TFA
cluster.client // PveClient: any endpoint by path
```

A VM handle covers the lifecycle, the config, snapshots, the guest agent and
both consoles. Every lifecycle call waits for the worker task, posting it again
while the guest's config lock is held, and returns its final status.

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()
const vm = cluster.vm(100)

await vm.configure({ memory: '4096', cores: 2 }) // synchronous PUT
await vm.start()
await vm.waitFor('running')
await vm.snapshot('before-upgrade')
await vm.guest.output(['uname', '-a']) // through the QEMU guest agent
await (await vm.os).output('hostname -f') // the OS helper: Linux, macOS or Windows
await vm.kvm.type('root\n') // keystrokes over VNC
await vm.console.waitForText('login:') // the serial console
await vm.api.start() // the module handle: returns the UPID
```

A container handle has the same lifecycle and runs its commands through `pct
exec` on its node.

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()
const ct = cluster.container(110)

await ct.exec('apk info') // { stdout, stderr, exitCode, durationMs }
const os = await ct.os // LinuxGuest through pct exec
await os.readFile('/etc/os-release')
const shell = await ct.shell // the node's root shell; shell.pct has push, pull, df, unlock
await shell.pct.df(110)
```

A node handle covers the node endpoints and the root shell on it.

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()
const node = cluster.node('pve1')

await node.status() // uptime, load, memory, kernel, PVE version, boot mode
await node.api.network.list()
await node.tasks() // worker tasks, newest first
const shell = await node.shell // SSH, or termproxy with a root@pam ticket
await shell.zfs.listPools()
await shell.systemd.restart('pvestatd')
await shell.output('pveversion -v')
```

For an endpoint with no wrapper, go through the client:

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()

const config = await cluster.client.get<Record<string, string>>('/nodes/pve1/qemu/100/config')
const upid = await cluster.client.post<string>('/nodes/pve1/qemu/100/status/start')
await cluster.client.waitForTask(upid)
```

## Documentation

- [Getting started](docs/getting-started.md): install, credentials, the first
  calls
- [Authentication tiers](docs/auth.md): the token, the root ticket and root
  SSH, and how the client decides
- [Guests](docs/guests.md): creating and driving QEMU VMs and LXC containers,
  running commands inside them
- [Consoles](docs/consoles.md): VNC input, screenshots, screen matchers, the
  serial console
- [The shell layer](docs/shell.md): root shells, the policy, ZFS, systemd, apt,
  `qm`, `pct`
- [Cluster and nodes](docs/cluster-and-nodes.md): status, HA, membership,
  access control, node settings
- [Storage](docs/storage.md): definitions, volumes, local disks, backups
- [Networking](docs/networking.md): the staged interface edit, guest networks,
  the firewall
- [Tasks and errors](docs/tasks-and-errors.md): UPIDs, waiting, the error tree
- [What the API cannot do](docs/api-gaps.md): and the shell call that covers it
- [Property strings](docs/property-strings.md): parsing and building config
  values
- [ARCHITECTURE.md](ARCHITECTURE.md): the internal contract

## Examples

`examples/` holds runnable scripts. Point them at a cluster with a `pve.env`
file; each script's header names the other variables it reads, such as
`PVE_STORAGE` and `PVE_TARGET_VMID`:

```sh
PVE_ENV_FILE=./pve.env bun run examples/cluster-state.ts
```

| Script | What it does |
| --- | --- |
| `cluster-state.ts` | Read cluster, node, storage, network and firewall state with GET requests only |
| `create-vm.ts` | Build a VM, boot it, screenshot the firmware screen, delete it |
| `create-container.ts` | Build a container from a template, run a command inside through `pct`, delete it |
| `run-commands.ts` | Run commands inside a VM through the guest agent and inside a container through `pct exec` |
| `install-over-kvm.ts` | Drive SeaBIOS over the VNC console, waiting on the screen at every step |
| `serial-console.ts` | Log in over the serial console and read a command's output back |
| `snapshots.ts` | Snapshot a scratch VM, change its config, roll back, delete |
| `zfs-shell.ts` | ZFS, systemd and apt through the root shell on a node |
| `tasks-and-errors.ts` | Watch a task by UPID, read its log, then trigger each error class |

`examples/support.ts` holds what they share: the variables, the scratch-guest
cleanup and the target VM helpers.

## Skill

`SKILL.md` is the manifest for an agent harness. The installer copies it, the
library and its dependencies into every skills directory it finds under
`~/.claude`, `~/.codex` and `~/.opencode`, and writes a `pve.env` with mode
600:

```sh
git clone https://github.com/paltaio/pve-agent.git
cd pve-agent
set -a; . ./pve.env; set +a
./install-pve-skill
```

It reads `PVE_HOST`, `PVE_PORT`, `PVE_USER`, `PVE_PASSWORD`, `PVE_TOKEN_ID`,
`PVE_TOKEN_SECRET`, `PVE_VERIFY_SSL` and `PVE_NODE` from the environment and
asks on the terminal for the missing ones; without a terminal, `PVE_HOST` and
one credential pair are required. Run from a checkout it installs that
checkout; run from elsewhere it clones `PVE_SKILL_REF` (default `main`).
`PVE_SKILL_SOURCE_DIR` names another checkout and `PVE_SKILL_OVERWRITE_ENV=1`
replaces an existing `pve.env`. It needs `bun` and `git` on PATH.

## Development

```sh
bun install
bun test                # the offline suite; live tests report as skipped
bun run typecheck       # tsc --noEmit over src, scripts, test and examples
bun run format          # oxfmt; format:check verifies without writing
```

The live suite runs against a real cluster. It creates and deletes scratch
guests, a scratch pool, a ZFS dataset and a user. `test/live/support.ts` names
the nodes, storages and guests it expects, each as a `PVE_LIVE_*` variable
with a default, and skips a test whose fixture the cluster does not hold:

```sh
set -a; . ./pve.env; set +a; PVE_LIVE=1 PVE_ENV_FILE=./pve.env bun test test/live
```

`PVE_GUEST_PASSWORD`, the login password of the target VM's user, is read from
the environment, so source the env file first. `PVE_LIVE_ALL=1` adds the
Windows and macOS groups, which boot and shut down whole desktops.

The registry in `src/generated` comes from `schema/apidoc.json`, dumped from a
node running the version in `schema/pve-version.txt`:

```sh
bun run schema root@pve1        # rewrites schema/ from the node
bun run generate                # rewrites src/generated from the schema
```

## Scope

Ceph and SDN endpoints are left out of the registry and have no wrappers; the
client reaches them with `{ allowUnknownEndpoint: true }`. Twelve endpoints and
a set of parameters accept only a `root@pam` ticket, listed in
[docs/auth.md](docs/auth.md). The library runs on Bun and uses its `fetch`,
`WebSocket` and `spawn`.

## License

Apache-2.0

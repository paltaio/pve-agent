# What the API cannot do

Each section names the gap and the call that covers it. Open a shell first:

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()

const node = cluster.node('ms01-0160')
const shell = await node.shell
```

## No endpoint at all

### Packages

The API refreshes the index and reads what it finds. It cannot install,
upgrade or remove anything: there is no endpoint for any of those. The GUI's
upgrade button opens a shell running `pveupgrade`.

| Want | Use |
| --- | --- |
| Install a package | `shell.apt.install(['htop'])` |
| Upgrade what is installed | `shell.apt.upgrade()` |
| Dist-upgrade | `shell.apt.distUpgrade()` |
| Remove or purge | `shell.apt.remove(['htop'])`, `shell.apt.purge(['htop'])` on a shell with `destructive: 'allow'` |
| Add or edit a repository entry | `shell.apt.addRepository(file, text)` |
| Add a signing key | `shell.apt.addKeyring(file, bytes)` |
| What an upgrade would do | `shell.apt.pendingUpgrades()` |
| Hold a package | `shell.apt.hold(['pve-kernel-6.14'])` |

`node.api.apt.setRepository` can enable or disable an existing entry, and
nothing else about a repository is settable.

### Services

`node.api.services` takes a fixed list of 23 systemd units and refuses any
other name. A custom unit, a timer, a drop-in, a mask, a unit file: none of
them have an endpoint.

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()
const shell = await cluster.node('ms01-0160').shell

await shell.systemd.restart('nginx.service')
await shell.systemd.writeUnit('app.service', '[Unit]\nDescription=app\n')
await shell.systemd.listTimers()
await shell.systemd.journal({ unit: 'nginx.service', lines: 200 })
```

`pveproxy`, `pvedaemon` and `pve-cluster` cannot be stopped through the API
at all.

### ZFS

The API covers pool create and destroy. An existing pool can be listed and
read and otherwise only removed. There is no endpoint for scrub, import,
export, add, attach, detach, replace, trim, upgrade, property set, dataset
create or native encryption.

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()
const shell = await cluster.node('ms01-0160').shell

await shell.zfs.scrub('tank')
await shell.zfs.importPool('tank')
await shell.zfs.createDataset('tank/data', { properties: { compression: 'zstd' } })
await shell.zfs.setProperty('tank/data', 'quota', '100G')
await shell.zfs.addVdev('tank', ['mirror', '/dev/sdd', '/dev/sde'])
await shell.zfs.loadKey('tank/secure', { keyLocation: 'file:///root/key' })
```

### Running a command inside a container

QEMU has `/agent/exec`. LXC has no guest agent and no equivalent endpoint, so
every command inside a container runs as `pct exec` over a root shell on its
node.

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()
const ct = cluster.container(110)

await ct.exec('apk info') // does this for you
await (await ct.shell).pct.exec(110, 'apk info') // the same thing, explicit
```

### Clearing a config lock

A container's config endpoint takes no `skiplock` and checks the lock on
every write, so a stale lock blocks every config change and the API cannot
clear it.

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()
const shell = await cluster.node('ms01-0160').shell

await shell.pct.unlock(110)
await shell.qm.unlock(100)
```

A VM can be unlocked through the API with `skiplock`, which needs a
`root@pam` ticket: `vm.api.unlock()`.

### Disk images from a node path

The API can only import a volume that already exists on a PVE storage. A file
sitting anywhere else on the node goes through `qm`:

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()
const shell = await cluster.node('ms01-0160').shell

await shell.qm.importDisk(9001, '/mnt/images/disk.qcow2', 'local-zfs', {
	targetDisk: 'scsi1',
	timeoutMs: 3_600_000,
})
await shell.qm.importOvf(9001, '/mnt/appliance.ovf', 'local-zfs')
```

### Node network beyond the fixed property set

Hook lines, policy routing, extra static routes, VRFs, tunnels, ethtool
settings and per-interface sysctls have no parameter on the interface
endpoint, and an interface the API rewrites drops them.

```ts
import pve, { shHeredoc } from 'pve-agent'

await using cluster = await pve.connect()
const shell = await cluster.node('ms01-0160').shell

const edited = await shell.output('cat /etc/network/interfaces')
await shell.run(`cat > /etc/network/interfaces ${shHeredoc(edited)}`, { check: true })
await shell.run('ifreload -a', { check: true })
```

### Other `qm` subcommands with no endpoint

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()
const shell = await cluster.node('ms01-0160').shell

await shell.qm.showCommand(100) // the generated kvm command line
await shell.qm.rescan({ vmid: 100, dryRun: true }) // find unreferenced volumes
await shell.qm.nbdStop(100) // stop a stuck NBD export
await shell.qm.enrollEfiKeys(100)
await shell.qm.cleanup(100, { cleanShutdown: true }) // after a crash
```

### Node files

Reading or writing a file on the node, such as `/etc/pve/storage.cfg` or a
guest config, has no endpoint outside the fixed set (`/etc/hosts`,
`/etc/resolv.conf`, the node config). Use the shell:

```ts
import pve, { shHeredoc, shQuote } from 'pve-agent'

await using cluster = await pve.connect()
const shell = await cluster.node('ms01-0160').shell

const text = await shell.output(`cat -- ${shQuote('/etc/pve/storage.cfg')}`)
await shell.run(`cat > /etc/motd ${shHeredoc('welcome\n')}`, { check: true })
await shell.download('/etc/pve/qemu-server/100.conf', './100.conf')
await shell.upload('./debian.iso', '/var/lib/vz/template/iso/debian.iso')
console.log(text.length)
```

## Endpoints that exist but need a `root@pam` ticket

Twelve endpoints are registered with no permissions block. An API token is a
different string from `root@pam` and cannot pass, however privileged. See
[auth.md](auth.md) for the list and the parameter-level cases.

The one most likely to surprise you is `POST /nodes/{node}/execute`, the
batch endpoint, since nothing about it looks privileged.

## Endpoints that answer, but not what you expect

### termproxy under a token

`POST /nodes/{node}/termproxy` is reachable on a token, but only a literal
`root@pam` gets a shell. Everyone else gets a `/bin/login` password prompt.

Use SSH for a root shell on a node. The four guest console endpoints,
`vncproxy`, `vncwebsocket`, `termproxy` and `spiceproxy`, do work on a token,
so guest consoles need nothing extra.

### HA groups

PVE 9 migrated HA groups to HA rules. Every group endpoint on a migrated
cluster answers 500 with "ha groups have been migrated to rules". Write node
placement as a node-affinity rule through `cluster.api.ha.createRule`.

### Firewall rule create

Create always prepends and ignores `pos`. Move the rule afterwards with
`update(0, { moveto })`. A rule created without `enable` is written disabled.

### `POST` versus `PUT` on a guest config

`POST .../config` is asynchronous and returns a UPID. `PUT .../config` takes
the same parameters, is synchronous and returns null. Use PUT unless the
change hotplugs a device or allocates storage. LXC has no POST form.

### LXC `unprivileged`

The schema documents `default: 0` and the create handler uses 1 when the
parameter is absent. `createContainer` sends `unprivileged: true` when the
spec leaves it out. On a restore it comes from the archive.

### Descriptions come back with a newline

PVE appends a trailing newline to every description it stores, on guests and
on snapshots. A caller comparing a description to what it just wrote gets a
false mismatch. Compare with `.trim()`.

### `/cluster/resources` is eventually consistent

It answers from the cache pvestatd refreshes every few seconds, so right
after a create or a template conversion it can still report stale data,
including `status: 'unknown'` and a stale template flag. Read the guest's own
`status` or `config` endpoint when the answer has to be current.

### `rrddata` on a young guest

It throws `PveNotFoundError` until pvestatd writes the first sample, roughly
a minute after the guest is created.

### `WARNINGS: n`

That is a task success status, not a failure. `waitForTask` treats it that
way unless you pass `failOnWarnings: true`.

### `/cluster/nextid`

The schema declares the answer an integer and the handler sends a JSON
string. `cluster.nextId()` reads either and returns a number. The answer is
only true at the moment of the call, so create the guest right after.

### LXC `suspend`

It freezes the container. PVE marks the endpoint experimental.

### `qm monitor`

PVE maps a small set of HMP commands onto normal VM privileges and refuses
everything else for anyone but `root@pam`. The registry cannot tell which is
which, so an unmapped command through `vm.api.monitor` reaches the node and
comes back as `PvePermissionError`. `shell.qm.monitor` runs as root.

### Property strings cannot hold a comma

`parse_property_string` on the node is a plain split on commas, with no
quoting and no escaping in the encoding at all. A value containing a comma
cannot be represented, and the encoder here refuses one for the same reason
the node does. Lists inside a value use semicolons. See
[property-strings.md](property-strings.md).

### A DELETE with a body

The API server refuses a DELETE that carries a body, so DELETE parameters
travel in the query string. `AccessApi.deleteTfa` sends the caller's password
that way, and it lands in the pveproxy access log.

## Out of scope

Ceph and SDN endpoints are left out of the registry and have no wrappers.
They are still reachable through the client with
`{ allowUnknownEndpoint: true }`:

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()

await cluster.client.get('/nodes/ms01-0160/ceph/status', undefined, {
	allowUnknownEndpoint: true,
})
```

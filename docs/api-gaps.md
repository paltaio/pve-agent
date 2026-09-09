# What the API cannot do

Each section names the gap and the call that covers it. Open a shell first:

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()

const node = cluster.node('pve1')
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

`node.api.services` takes a fixed list of 23 systemd units, exported as
`NODE_SERVICES`, and refuses any other name. A custom unit, a timer, a
drop-in, a mask, a unit file: none of them have an endpoint.

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()
const shell = await cluster.node('pve1').shell

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
const shell = await cluster.node('pve1').shell

await shell.zfs.scrub('tank')
await shell.zfs.importPool('tank')
await shell.zfs.createDataset('tank/data', { properties: { compression: 'zstd' } })
await shell.zfs.setProperty('tank/data', 'quota', '100G')
await shell.zfs.addVdev('tank', ['mirror', '/dev/sdd', '/dev/sde'])
await shell.zfs.loadKey('tank/secure', { keyLocation: 'file:///root/key' })
```

[shell.md](shell.md) lists the whole ZFS surface.

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
const shell = await cluster.node('pve1').shell

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
const shell = await cluster.node('pve1').shell

await shell.qm.importDisk(9001, '/mnt/images/disk.qcow2', 'local-zfs', {
	targetDisk: 'scsi1',
	timeoutMs: 3_600_000,
})
await shell.qm.importOvf(9001, '/mnt/appliance.ovf', 'local-zfs')
```

### Node network beyond the fixed property set

Hook lines, policy routing, extra static routes, VRFs, tunnels, ethtool
settings and per-interface sysctls have no parameter on the interface
endpoint, and an interface the API rewrites drops them. Editing the file over
the shell, and the connectivity risk that carries, is in
[networking.md](networking.md).

### Other `qm` subcommands with no endpoint

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()
const shell = await cluster.node('pve1').shell

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
const shell = await cluster.node('pve1').shell

const text = await shell.output(`cat -- ${shQuote('/etc/pve/storage.cfg')}`)
await shell.run(`cat > /etc/motd ${shHeredoc('welcome\n')}`, { check: true })
await shell.download('/etc/pve/qemu-server/100.conf', './100.conf')
await shell.upload('./debian.iso', '/var/lib/vz/template/iso/debian.iso')
console.log(text.length)
```

## Endpoints that exist but need a `root@pam` ticket

Twelve endpoints are registered with no permissions block, and their handlers
compare the caller against the string `root@pam`, which an API token never
matches. [auth.md](auth.md) lists them and the parameter-level cases. The one
most likely to surprise you is `POST /nodes/{node}/execute`, the batch
endpoint, since nothing about it looks privileged.

## Endpoints that answer, but not what you expect

| Endpoint | What happens | Details |
| --- | --- | --- |
| `POST /nodes/{node}/termproxy` | A caller other than `root@pam` gets a `/bin/login` prompt | [shell.md](shell.md) |
| `/cluster/ha/groups/*` | 500 on a cluster migrated to HA rules | [cluster-and-nodes.md](cluster-and-nodes.md) |
| Firewall rule create | Prepends and ignores `pos`; a rule without `enable` is stored disabled | [networking.md](networking.md) |
| `POST` on a guest config | Asynchronous, answers a UPID; `PUT` is synchronous | [guests.md](guests.md) |
| LXC create `unprivileged` | The handler defaults to 1, the schema says 0 | [guests.md](guests.md) |
| Any description | Comes back with a trailing newline | [guests.md](guests.md) |
| `/cluster/resources` | Answers from the pvestatd cache, seconds behind | [getting-started.md](getting-started.md) |
| `rrddata` on a young guest | `PveNotFoundError` until pvestatd writes the first sample | [guests.md](guests.md) |
| A task ending `WARNINGS: n` | A success status | [tasks-and-errors.md](tasks-and-errors.md) |
| `/cluster/nextid` | Sends a JSON string for a declared integer; `cluster.nextId()` returns a number, true only at the moment of the call | |
| LXC `suspend` | Freezes the container; PVE marks the endpoint experimental | [guests.md](guests.md) |
| `qm monitor` through the API | Only a small set of HMP commands is mapped onto VM privileges; anything else is `PvePermissionError` for a caller other than `root@pam`, while `shell.qm.monitor` runs as root | [shell.md](shell.md) |
| Property strings | No quoting: a value cannot hold a comma | [property-strings.md](property-strings.md) |
| `DELETE /access/tfa/{userid}/{id}` | `AccessApi.deleteTfa` sends a non-root caller's password in the query string, where the pveproxy access log records it; a `root@pam` ticket sends none, and any other caller should change the password afterwards | |

## Out of scope

Ceph and SDN endpoints are left out of the registry and have no wrappers.
They are still reachable through the client with
`{ allowUnknownEndpoint: true }`:

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()

await cluster.client.get('/nodes/pve1/ceph/status', undefined, {
	allowUnknownEndpoint: true,
})
```

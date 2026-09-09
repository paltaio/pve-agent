# Guests

QEMU virtual machines and LXC containers share one vmid space and most of one
API. `PveVm` and `PveContainer` share everything both types do and each adds
what only it has.

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()

const vm = cluster.vm(100) // sends nothing
const ct = cluster.container(110, 'pve3')
const guest = await cluster.guest(110) // one lookup, whichever type it is

if (guest.type === 'qemu') await guest.kvm.press('enter')
```

## Creating a VM

Disks are config keys. `scsi0: 'local-zfs:16'` allocates
16 GiB on `local-zfs`; `scsi0: 'local-zfs:0,import-from=<volume>'` imports an
existing image and takes the size from it.

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()

const vm = await cluster.createVm({
	node: 'pve1', // defaults to PVE_NODE
	vmid: 9001, // defaults to the lowest free id
	name: 'demo',
	memory: '2048',
	cores: 2,
	ostype: 'l26',
	bios: 'ovmf',
	efidisk0: 'local-zfs:1,efitype=4m,pre-enrolled-keys=0',
	scsihw: 'virtio-scsi-single',
	scsi0: 'local-zfs:16',
	net0: 'virtio,bridge=vmbr0',
	vga: 'std',
	agent: '1',
	ide2: 'local:iso/debian-13.iso,media=cdrom',
	start: true,
})
```

`createVm` waits for the create task and returns the handle. Needs
`VM.Allocate` on `/vms` plus `Datastore.AllocateSpace` on every storage the
config touches. `memory` and `agent` are strings on a VM, as the schema
declares them.

To restore from a backup, set `archive`; the other keys become overrides on
the archived config, `force: true` overwrites an existing vmid, and
`live-restore: true` boots the VM while the data streams in:

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()

const vm = await cluster.createVm({
	node: 'pve1',
	vmid: 9001,
	archive: 'backup:backup/vzdump-qemu-100-2026_09_01-03_00_00.vma.zst',
	force: true,
})
```

## Creating a container

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()
const required = (name: string): string => {
	const value = process.env[name]
	if (!value) throw new Error(`${name} is not set`)
	return value
}

const ct = await cluster.createContainer({
	node: 'pve1',
	hostname: 'demo',
	ostemplate: 'local:vztmpl/debian-13-standard_13.0-1_amd64.tar.zst',
	rootfs: 'local-zfs:8',
	memory: 512,
	swap: 0,
	cores: 1,
	net0: 'name=eth0,bridge=vmbr0,ip=dhcp',
	mp0: 'local-zfs:32,mp=/data',
	password: required('CT_PASSWORD'),
	unprivileged: true,
	start: true,
})
```

`unprivileged` documents `default: 0` in the schema and the create handler
uses 1 when the parameter is absent. `createContainer` sends
`unprivileged: true` when the spec leaves it out. A restore (`restore: true`
with the backup in `ostemplate`) keeps the value from the archive.

A bind or device mount point, `dev[n]`, `hookscript`, and any `features` past
`nesting` need a `root@pam` ticket. See [auth.md](auth.md).

## Status and config

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()
const guest = await cluster.guest(100)

const status = await guest.status()
console.log(status.status, status.runState, status.lock, status.uptime, status.pid)
console.log(status.haManaged, status.qmpStatus, status.agentEnabled, status.raw)
```

`status` is what the node reported; `runState` folds a QEMU pause into
`'paused'`, because PVE reports `running` for a VM that QEMU has paused.
Everything the node sent is kept under `raw`.

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()
const vm = cluster.vm(100)

const config = await vm.config()
console.log(config.memory, config.cores, config.digest, config.tags)
console.log(config.disks['scsi0']?.['file']) // 'local-zfs:vm-100-disk-0'
console.log(config.nets['net0']?.['macaddr'])
console.log(config.raw['scsi0']) // 'local-zfs:vm-100-disk-0,size=16G'

await vm.config({ current: true }) // what the running guest started with
await vm.config({ snapshot: 'before' }) // the config stored in a snapshot
```

A `QemuConfig` carries `disks`, `nets`, `unused` and `agent` parsed into
sub-keys, and an `LxcConfig` carries `rootfs`, `mounts`, `nets` and
`features`. `digest` is a SHA1 of the config file. Pass it back as `digest`
on a write to reject a racing edit.

### Writing config

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()
const vm = cluster.vm(100)

await vm.configure({ memory: '4096', description: 'built by hand', tags: 'demo;lab' })
await vm.api.deleteConfigKeys(['description', 'tags'])
await vm.setNotes('owner: platform') // the description field; notes() reads it
```

`configure` is the synchronous `PUT`: the change is on disk when the call
returns. `POST` on the same path takes the same parameters, runs as a worker
task and returns a UPID. Use the async form when the change hotplugs a device
or allocates storage:

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()
const vm = cluster.vm(100)

const upid = await vm.api.setConfigAsync({ scsi1: 'local-zfs:32', background_delay: 5 })
await cluster.waitForTask(upid)
```

LXC has only the `PUT`. Its config handler takes no `skiplock` and checks the
lock on every write, so a container holding a stale lock refuses every config
change until `pct unlock` clears it:

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()

const ct = cluster.container(110)
await (await ct.shell).pct.unlock(110)
```

A VM can be unlocked through the API, but `skiplock` needs a `root@pam`
ticket:

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()

await cluster.vm(100).api.unlock()
```

### Pending changes

A change that only takes effect at the next start sits in `pending`:

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()
const vm = cluster.vm(100)

for (const change of await vm.api.pending()) {
	console.log(change.key, change.value, '->', change.pending)
}
await vm.api.revertPending(['memory'])
```

## Lifecycle

Every call on the handle waits for the worker task and returns its final
`TaskStatus`.

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()
const vm = cluster.vm(100)

await vm.start()
await vm.shutdown({ timeout: 60, forceStop: true })
await vm.stop() // kills the process; the OS never learns
await vm.reboot() // shutdown then start, applying pending changes
await vm.suspend()
await vm.resume()
await vm.reset() // the reset button
await vm.delete({ purge: true })
```

`purge` also drops the guest from backup jobs, replication jobs and HA.
`delete` closes any console session this handle opened first, since a deleted
guest's websocket goes away underneath it. A container's `delete` also takes
`force` for a running container, and its `suspend` freezes it; PVE marks that
endpoint experimental.

A task that fails with `can't lock file ... got timeout` did nothing: the
node takes the guest's config lock before it changes anything. The power calls
and `delete` on a handle post the task again for up to 45 seconds while it
fails that way. The usual cause is `qm cleanup`, which qmeventd runs when a
QEMU process exits and which holds the lock for up to 30 seconds when a
process with the same vmid is running again, as happens when a VM is deleted
and its vmid recreated straight away. `api.stop()` and the other module calls
return the UPID and leave the retry to the caller.

A start or stop task can finish before the guest has settled, so wait on the
guest itself:

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()
const vm = cluster.vm(100)

const running = await vm.waitFor('running', { timeoutMs: 120_000 })
console.log(running.pid, running.cpus)
```

`waitFor` throws `PveTimeoutError` on timeout, naming the state the guest was
in.

`guest.api` is the module handle underneath. Its lifecycle calls return the
raw UPID, which is what you want when several operations run together:

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()
const vms = [cluster.vm(100), cluster.vm(101), cluster.vm(102)]

const upids = await Promise.all(vms.map((vm) => vm.api.start()))
await Promise.all(upids.map((upid) => cluster.waitForTask(upid)))
```

## Snapshots

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()
const vm = cluster.vm(100)

await vm.snapshot('before-upgrade', { description: 'known good', vmstate: true })
const snapshots = await vm.snapshots() // includes the 'current' pseudo-entry
console.log(snapshots.map((snapshot) => snapshot.name))
await vm.rollback('before-upgrade', { start: true })
await vm.deleteSnapshot('before-upgrade', { force: true })

await vm.api.snapshots.config('before-upgrade')
await vm.api.snapshots.update('before-upgrade', { description: 'still good' })
```

A VM snapshot can carry RAM with `vmstate: true`, so the rollback resumes a
running VM where it left off. A container snapshot takes a `description` and
nothing else.

PVE stores every description with a trailing newline, so a description read
back is `text + '\n'`. Compare with `.trim()`.

## Cloning, migrating, resizing

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()
const vm = cluster.vm(100)
const ct = cluster.container(110)

await vm.clone({ newid: 9010, full: true, storage: 'local-zfs', name: 'copy' })
await vm.migrate({ target: 'pve2', online: true, bwlimit: 100_000 })
await ct.migrate({ target: 'pve2', restart: true })

const pre = await vm.api.migratePreconditions('pve2')
console.log(pre.allowedNodes, pre.notAllowedNodes, pre.localDisks, pre.localResources)
```

Without `full`, a template is copied as a linked clone; a normal VM is always
copied in full. A running container needs `restart: true`, which stops it,
moves it and starts it again. `migratePreconditions` reads both the QEMU and
the LXC key spellings and answers one shape.

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()
const vm = cluster.vm(100)
const ct = cluster.container(110)

await cluster.waitForTask(await vm.api.resize({ disk: 'scsi0', size: '+8G' }))
await cluster.waitForTask(await ct.api.resize({ disk: 'rootfs', size: '32G' }))
```

`size` is absolute, or relative with a leading `+`. Shrinking is refused.

VM only:

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()
const vm = cluster.vm(100)

await cluster.waitForTask(await vm.api.moveDisk({ disk: 'scsi0', storage: 'fast-nvme', delete: true }))
await vm.api.unlink(['unused0'], { force: true })
await cluster.waitForTask(await vm.api.toTemplate())
```

Container only:

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()
const ct = cluster.container(110)

await cluster.waitForTask(await ct.api.moveVolume({ volume: 'mp0', storage: 'fast-nvme', delete: true }))
await ct.api.toTemplate() // synchronous; answers null
```

## Running commands inside a guest

The two guest types take different paths in, and the OS helper on `os` hides
which:

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()
const vm = cluster.vm(100)
const ct = cluster.container(110)

const os = await vm.os // LinuxGuest, DarwinGuest or WindowsGuest
const result = await os.run('systemctl is-active sshd') // { exitCode, stdout, stderr, timedOut }
console.log(result.exitCode, result.stdout)
await os.output('uname -a') // trimmed stdout; throws GuestCommandError on a non-zero exit
await os.sh('set -e\napt-get update\napt-get install -y curl', { timeoutMs: 600_000 })

const linux = await ct.os // LinuxGuest through pct exec
await linux.output('apk info')
```

`run` takes one command line for the guest's command interpreter: `/bin/sh -c`
on Linux and macOS, `cmd.exe /c` on Windows. `sh` takes a script, which may
span lines, for `/bin/sh` or for PowerShell. `exec` takes an argument vector
with no shell between. A non-zero exit is a result on `run`, `sh` and `exec`;
`output` and the file helpers throw `GuestCommandError` carrying `vmid`,
`exitCode`, `stdout` and `stderr`. A command still running when the deadline
passes comes back with `timedOut: true`, or throws `PveTimeoutError` from
`output`. The deadline defaults to 30 seconds; `timeoutMs` changes it.

- A VM goes through the QEMU guest agent. The VM needs `agent: '1'` in its
  config and `qemu-guest-agent` running inside. Without both, the node answers
  500 with "No QEMU guest agent configured" or "QEMU guest agent is not
  running".
- A container has no guest agent. Every command runs as `pct exec` over a
  root shell on the container's node, so `ct.os` and `ct.exec` need an SSH key
  for root on that node, or a `root@pam` ticket for the termproxy fallback.

Wait for the agent before the first VM command:

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()
const vm = cluster.vm(100)

await vm.start()
await vm.waitForAgent({ timeoutMs: 300_000 })
```

It polls `agent.ping()` and throws `PveTimeoutError` on timeout, which
usually means the agent is not installed or the config has no `agent`.

### OS helpers

`vm.os` reads `ostype` from the config, treats an Apple SMC device in `args`
as macOS, and asks the agent when the config says nothing usable. The answer
is kept; a failed open is retried on the next await.

```ts
import pve, { LinuxGuest, WindowsGuest } from 'pve-agent'

await using cluster = await pve.connect()
const os = await cluster.vm(100).os

const info = await os.osInfo() // { os, id, name, version, prettyName, kernel, arch, raw }
console.log(info.prettyName)
await os.writeFile('/etc/foo.conf', 'key = value\n')
console.log(await os.readFile('/etc/foo.conf'))
console.log(await os.exists('/var/run/reboot-required'))
await os.download('https://example.com/file.tar', '/tmp/file.tar')
await os.delete('/tmp/file.tar')
await os.hostname()

if (os instanceof LinuxGuest) {
	await os.systemctl(['restart', 'nginx'])
	await os.writeFile('/etc/foo.conf', 'key = value\n', { sudo: true, mode: '0644' })
	await os.sudo('apt-get update')
}
if (os instanceof WindowsGuest) {
	await os.cmd('ver')
	await os.powershell('Get-CimInstance Win32_OperatingSystem | Select-Object Caption')
}
```

All three carry `run`, `sh`, `exec`, `output`, `readFile`, `readFileBytes`,
`writeFile`, `delete`, `exists`, `download`, `hostname`, `osInfo`, `reboot`
and `shutdown`; files move as base64 so binary survives. The POSIX helpers add
`sudo`, Linux adds `systemctl`, macOS adds `osascript` and `setClipboard`,
Windows adds `cmd` and `powershell`. A Windows script goes over as
`-EncodedCommand`, a UTF-16 base64 blob, so quotes, pipes and newlines arrive
untouched.

### The raw agent surface

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()
const agent = cluster.vm(100).guest
const required = (name: string): string => {
	const value = process.env[name]
	if (!value) throw new Error(`${name} is not set`)
	return value
}

await agent.ping()
await agent.osInfo()
await agent.networkInterfaces()
await agent.filesystems()
await agent.fsfreezeFreeze()
await agent.fsfreezeThaw()
await agent.fstrim()
await agent.setUserPassword({ username: 'root', password: required('VM_PASSWORD') })
const file = await agent.fileRead('/etc/hostname') // { content, truncated, bytesRead }
await agent.fileWrite('/tmp/x', 'hello\n')
const pid = await agent.startExec(['sleep', '30'])
await agent.execStatus(pid)
const result = await agent.exec(['systemctl', 'is-active', 'sshd']) // polls until it exits
await agent.output(['uname', '-a']) // throws GuestCommandError on a non-zero exit
```

The agent takes an argv and runs no shell, so a pipeline needs an explicit
`['sh', '-c', '...']`. `exec` returns `exitCode` and `signal` as the agent
reports them, and `timedOut: true` with the pid when the deadline passes
first.

A container's counterpart to the agent's network query needs no agent:

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()

await cluster.container(110).api.interfaces() // name, hwaddr, inet, inet6, ip-addresses
```

### The container's node shell

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()
const ct = cluster.container(110)

await ct.exec('apk info') // pct exec through sh -c: { stdout, stderr, exitCode, durationMs }
await ct.exec('id', { shell: 'bash', timeoutMs: 10_000 })

const shell = await ct.shell // the node's root shell
await shell.pct.execArgv(110, ['/usr/bin/env'], { keepEnv: false })
await shell.pct.push(110, '/tmp/on-node', '/opt/in-container', { perms: '0644' })
await shell.pct.pull(110, '/var/log/messages', '/tmp/on-node')
await shell.pct.pushLocalFile(110, './app.tar', '/opt/app.tar')
await shell.pct.pullToLocalFile(110, '/opt/report.json', './report.json')
await shell.pct.df(110)
await shell.pct.config(110)
await shell.pct.mount(110)
await shell.pct.unmount(110)
await shell.pct.fsck(110)
await shell.pct.unlock(110)
```

See [shell.md](shell.md).

## Firewall

Both types register the same firewall subtree:

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()
const guest = await cluster.guest(100)

await guest.firewall.setOptions({ enable: true, policy_in: 'DROP' })
await guest.firewall.rules.create({ type: 'in', action: 'ACCEPT', dport: '22', enable: 1 })
const rules = await guest.firewall.rules.list()
await guest.firewall.rules.update(0, { moveto: 3 })
await guest.firewall.rules.delete(2)
await guest.firewall.log({ limit: 100 })
```

`guest.firewall.rules` is the same `FirewallRulesApi` the datacenter and node
chains use, so a rule read off a guest and a rule read off the cluster are
the same type. Rules are addressed by position, and create always prepends
and ignores `pos`. A rule created without `enable` is written disabled. See
[networking.md](networking.md).

## Metrics

```ts
import pve, { PveNotFoundError } from 'pve-agent'

await using cluster = await pve.connect()

try {
	const points = await cluster.vm(100).api.rrddata({ timeframe: 'hour', cf: 'AVERAGE' })
	console.log(points.length)
} catch (error) {
	if (!(error instanceof PveNotFoundError)) throw error
	// pvestatd has not written the first sample yet
}
```

`rrddata` throws `PveNotFoundError` while the RRD file does not exist, which
is the case for the first minute after a guest is created.

## Storage features

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()

const feature = await cluster.vm(100).api.feature('snapshot')
console.log(feature.hasFeature, feature.nodes)
```

Answers whether `snapshot`, `clone` or `copy` is available on the storage
this guest sits on.

## Discovery without a handle

The functions under the facade take a client and answer with module handles:

```ts
import pve, { findGuest, listContainers, listGuests, listVms, openGuest } from 'pve-agent'

await using cluster = await pve.connect()
const client = cluster.client

await listGuests(client, { node: 'pve1', excludeTemplates: true })
await findGuest(client, 110) // undefined when the vmid is free
const api = await openGuest(client, 110) // QemuApi or LxcApi; throws PveNotFoundError
console.log(api.type, api.path)
await listVms(client, 'pve1', { full: true })
await listContainers(client, 'pve1')
```

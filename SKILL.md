---
name: pve-agent
description: Drive a Proxmox VE cluster from TypeScript on Bun. Covers the REST API, QEMU and LXC guests, the VNC keyboard, mouse and screen, serial consoles, the QEMU guest agent, pct exec, and a root shell on any node. Use when creating or configuring VMs and containers, driving firmware or an installer over the VNC console, running commands inside a guest, reading cluster, node or storage state, or doing ZFS, systemd and apt work on a node.
---

# pve-agent

TypeScript library for a Proxmox VE cluster. Import it, write a script, run it
with bun. Everything hangs off one connected cluster object.

## Credentials

`pve.env` next to this file, or the process environment:

```sh
PVE_HOST=192.168.80.21
PVE_PORT=8006
PVE_VERIFY_SSL=0
PVE_NODE=ms01-0160
PVE_TOKEN_ID=agents@pve!automation
PVE_TOKEN_SECRET=...
PVE_USER=root@pam
PVE_PASSWORD=...
```

Resolution order: arguments to `pve.connect()`, then `process.env`, then the
env file named by `envFile`, `PVE_ENV_FILE`, or `./pve.env` in the working
directory. A line may start with `export `. `PVE_PORT` defaults to 8006.
`PVE_VERIFY_SSL` defaults to on; `0`, `false`, `no` or `off` turn it off.
`PVE_NODE` is the node a call uses when none is named. A `PVE_TOKEN_ID`
without a `!` is joined to `PVE_USER`. `PVE_USER` with `PVE_PASSWORD` logs in
for a ticket; `PVE_TOKEN_ID` with `PVE_TOKEN_SECRET` is an API token. Either
alone works; with both set the client picks per call.

## Running a script

`./pve.env` resolves against the working directory, so point `PVE_ENV_FILE` at
the skill's copy.

```sh
PVE_ENV_FILE=<skill-dir>/pve.env bun -e 'import pve from "<skill-dir>/src/index.ts"; await using c = await pve.connect(); console.log(await c.list())'
```

```sh
PVE_ENV_FILE=<skill-dir>/pve.env bun - <<'EOF'
import pve from '<skill-dir>/src/index.ts'
await using cluster = await pve.connect()
console.log(await cluster.vm(100).status())
EOF
```

Anything longer goes in `/tmp/pve-<task>.ts`, run the same way with
`bun /tmp/pve-<task>.ts`. Edit that file for the next step.

## The facade

```ts
import pve from '<skill-dir>/src/index.ts'

await using cluster = await pve.connect() // one GET /version; close() on scope exit

await cluster.version() // { version, release, repoid }
await cluster.nodes() // every node with status and resource totals
await cluster.list() // every guest, both types, sorted by vmid
await cluster.nextId() // lowest free vmid at or above 100

cluster.vm(100) // PveVm on PVE_NODE; cluster.vm(100, 'ms02-0066') names the node; sends nothing
cluster.container(110) // PveContainer, same rule
await cluster.guest(100) // finds node and type with one GET
cluster.node() // PveNode for PVE_NODE, or cluster.node('ms01-0160')

await cluster.createVm({ name: 'test', memory: '2048', scsi0: 'local-zfs:16', net0: 'virtio,bridge=vmbr0' })
await cluster.createContainer({ ostemplate: 'local:vztmpl/debian-13-standard_13.0-1_amd64.tar.zst', rootfs: 'local-zfs:8' })
await cluster.waitForTask(upid) // final TaskStatus; throws PveTaskError

cluster.api // ClusterApi: ha, backup, firewall, pools, storage, replication, membership
cluster.access // AccessApi: users, groups, roles, ACLs, tokens, realms
cluster.client // PveClient: any endpoint by path
```

`createVm` and `createContainer` wait for the create task and return the
handle. Disks are config keys: `scsi0: 'local-zfs:16'` allocates 16 GiB.

### VM handle

Every lifecycle call waits for the worker task and returns its final status.

```ts
const vm = cluster.vm(100)

await vm.status() // { status, runState, lock, pid, cpus, maxmem, tags, raw }
await vm.config() // QemuConfig
await vm.configure({ memory: '4096', cores: 2 }) // synchronous PUT
await vm.api.setConfigAsync({ scsi1: 'local-zfs:32' }) // UPID; for hotplug and storage

await vm.start()
await vm.waitFor('running') // polls the guest; throws PveTimeoutError
await vm.shutdown() // ACPI; stop() kills, reboot() is an OS reboot, reset() a power cycle

await vm.snapshot('before-upgrade')
await vm.snapshots()
await vm.rollback('before-upgrade')
await vm.deleteSnapshot('before-upgrade')
await vm.clone({ newid: 101, full: true })
await vm.migrate({ target: 'ms02-0066', online: true })
await vm.setNotes('owner: platform') // the config description; notes() reads it
await vm.delete({ purge: true }) // stopped VM only; purge also drops backup, replication and HA entries

vm.guest // QemuAgent
vm.os // Promise<GuestOs>
vm.kvm // VmKvm: VNC keyboard, mouse and screen
vm.console // GuestConsole: serial
vm.api // QemuApi: the same calls, returning the UPID
```

### Container handle

Status, config, lifecycle, snapshots, notes and delete work as on a VM.

```ts
const ct = cluster.container(110)

await ct.exec('apt-get update') // pct exec on the node: { stdout, stderr, exitCode, durationMs }
const os = await ct.os // LinuxGuest through pct exec
const shell = await ct.shell // the node's root shell; shell.pct has push, pull, df, unlock
ct.console // GuestConsole; a container always has one. ct.api is the LxcApi
```

A container has no guest agent. `exec`, `os` and `shell` all go through a root
shell on the container's node, so they need an SSH key for root on the node or
a root@pam ticket.

### Node handle

```ts
const node = cluster.node('ms01-0160')

await node.status() // uptime, load, memory, kernel, PVE version, boot mode
await node.tasks() // worker tasks, newest first
node.api // NodeApi: network, storage, disks, firewall, apt, certificates, services, hardware, scan, tasks, replication, backup
const shell = await node.shell // NodeShell
```

## Guest commands

The guest agent takes an argv and runs no shell. It needs `agent=1` in the VM
config and the agent running inside.

```ts
await vm.waitForAgent() // after a boot, before the first agent call

const r = await vm.guest.exec(['systemctl', 'is-active', 'sshd']) // { exitCode, signal, stdout, stderr, timedOut, pid }
await vm.guest.output(['uname', '-a']) // trimmed stdout; throws on a non-zero exit
await vm.guest.fileRead('/etc/hostname') // { content, truncated, bytesRead }
await vm.guest.fileWrite('/etc/motd', 'hello\n')
await vm.guest.ping() // osInfo, hostName, networkInterfaces, filesystems, users
```

The OS helper takes a command line for the guest's command interpreter:
`/bin/sh -c` on Linux and macOS, `cmd.exe /c` on Windows. `sh` takes a script
for `/bin/sh`, or PowerShell on Windows. `vm.os` reads the config or asks the
agent to pick the helper.

```ts
const os = await vm.os // LinuxGuest, DarwinGuest or WindowsGuest

await os.run('ls /nonexistent') // { exitCode, stdout, stderr, timedOut }; returns on a non-zero exit
await os.output('hostname -f') // trimmed stdout; throws on a non-zero exit
await os.sh('set -e\napt-get update\napt-get install -y curl', { timeoutMs: 600_000 })
await os.readFile('/etc/os-release')
await os.writeFile('/root/.ssh/authorized_keys', key, { mode: '0600' })
await os.exists('/var/run/reboot-required') // also hostname, delete, download, reboot, shutdown
await os.osInfo() // { os, id, name, version, prettyName, kernel, arch, raw }
```

Linux adds `systemctl(args)`, the POSIX helpers add `sudo(command)`, Windows
adds `cmd(line)` and `powershell(script)`, macOS adds `osascript(script)`.

`exec` and `run` return `exitCode` (128 plus the signal number for a process a
signal killed) and `timedOut: true` when the deadline passes with the process
still running (30 seconds by default; `timeoutMs` changes it). `output` and
the file helpers throw `GuestCommandError` on a non-zero exit, carrying `vmid`,
`exitCode`, `stdout` and `stderr`, and `PveTimeoutError` on the deadline.

## The VNC console

`vm.kvm` is the keyboard, mouse and framebuffer the firmware and the OS see.
The VM has to be running. The session opens on the first call.

```ts
await vm.kvm.press('ctrl-alt-delete') // also 'f2', 'enter', 'esc', 'tab', 'ctrl-c'
await vm.kvm.type('root\n', { cps: 20 }) // newline goes out as enter
await vm.kvm.keyDown('shift') // held until keyUp('shift')
await vm.kvm.click(400, 300, 'left') // move(x, y) for the pointer alone
await vm.kvm.scroll(400, 300, 'down', 3)

const shot = await vm.kvm.screenshot({ format: 'png' }) // { format, width, height, data: Buffer, seq }
await Bun.write('/tmp/vm100.png', shot.data)
await vm.kvm.screenshot({ format: 'jpeg', quality: 70, fresh: true }) // fresh asks the guest for a repaint first

const frame = await vm.kvm.snapshot() // raw frame: { width, height, buffer, seq }
await vm.kvm.match({ kind: 'color', color: '#000098', area: 0.02 }) // { matched, results }
await vm.kvm.waitForScreen({ kind: 'pixel', x: 10, y: 10, color: '#ffffff' }, { timeoutMs: 60_000 })
await vm.kvm.waitForScreen({ kind: 'changed', since: frame }, { timeoutMs: 30_000 })
await vm.kvm.waitForScreen((f) => f.width >= 1024, { timeoutMs: 10_000 }) // any predicate on the frame
```

Matchers: `pixel` (one pixel near a colour), `color` (a fraction of a region
near a colour), `changed` (a fraction of a region differs from a reference
frame). `waitForScreen` throws `PveTimeoutError`.

An idle VM shows a blank 640x480 surface. Press a key and wait for the
full-size frame before taking a screenshot:

```ts
await vm.kvm.press('shift')
await vm.kvm.waitForScreen((f) => f.width > 640, { timeoutMs: 10_000 })
const shot = await vm.kvm.screenshot({ format: 'png' })
```

## The serial console

A VM needs `serial0: socket` in its config and a getty on the port inside the
guest (`console=ttyS0` on the kernel command line, or
`systemctl enable --now serial-getty@ttyS0`). A container's console always
exists. Output is rendered through a headless terminal, so `screen()` is what a
user would see.

```ts
await vm.configure({ serial0: 'socket' }) // takes effect on the next start

await vm.console.waitForText(/login:/, { timeoutMs: 120_000 })
await vm.console.login('root', password) // resolves with the screen at a shell prompt
await vm.console.sendLine('ip -4 addr')
const screen = await vm.console.waitForPrompt()
await vm.console.sendKey('ctrl-c') // named keys: enter, tab, escape, backspace, up, down, f1..f12, ctrl-a..ctrl-z
await vm.console.readNew() // text rendered since the previous call; screen() is the whole screen
```

`waitForText` and `waitForPrompt` look at the output rendered since the last
`sendLine`, or the whole screen before any, and throw `PveTimeoutError`
carrying the last screen. `login` throws `PveConsoleError` when the guest
refuses the credentials.

## The node shell

`node.shell` is a root shell on the node: SSH when a key is authorised for
root, otherwise the termproxy websocket, which needs a root@pam ticket. One
shell per node, shared by every handle on that node.

```ts
const shell = await node.shell
shell.kind // 'ssh' | 'termproxy'

await shell.run('zpool status', { timeoutMs: 60_000 }) // { stdout, stderr, exitCode, durationMs }
await shell.run('pvesm status', { check: true }) // check throws PveShellCommandError on a non-zero exit
await shell.output('hostname -f') // trimmed stdout; throws on a non-zero exit
await shell.upload('/tmp/debian.iso', '/var/lib/vz/template/iso/debian.iso')
await shell.download('/etc/pve/qemu-server/100.conf', '/tmp/100.conf')

await shell.zfs.poolStatus('rpool') // listPools() for all of them
await shell.zfs.listDatasets({ target: 'rpool/data', depth: 1 })
await shell.zfs.createDataset('rpool/data/scratch', { properties: { compression: 'zstd' } })
await shell.zfs.snapshot('rpool/data/scratch@before')
await shell.zfs.scrub('rpool')

await shell.systemd.restart('pveproxy') // status, isActive, enable, disable, mask
await shell.systemd.journal({ unit: 'pve-cluster', lines: 50, since: '-1h' })
await shell.systemd.writeUnit('scrub.service', unitText)

await shell.apt.update()
await shell.apt.install(['curl']) // listUpgradable, upgrade, remove, policy, hold

await shell.qm.monitor(100, 'info status') // list, config, unlock, showCommand
await shell.qm.importDisk(100, '/tmp/disk.qcow2', 'local-zfs', { targetDisk: 'scsi1' })

await shell.pct.exec(110, 'id')
await shell.pct.push(110, '/tmp/file', '/root/file', { perms: '0600' }) // pull, df, unlock, mount
```

The shell refuses commands that match its destructive patterns (`rm -rf`,
`zfs destroy`, `zpool destroy`, `wipefs`, `mkfs`, `dd of=`, `qm destroy`,
`apt remove`, `reboot`, `poweroff`) with `PveShellPolicyError`. Allow them for
a script with `pve.connect({ shell: { policy: { destructive: 'allow' } } })`.

## Tasks and errors

A lifecycle call on a handle waits for its worker task. The `api` object
underneath returns the UPID instead; `cluster.waitForTask(upid, options)`
waits for it, 10 minutes by default. `WARNINGS: n` counts as success unless
`failOnWarnings: true`.

Every error extends `PveError` and carries `kind`:

| Class | Kind | When |
| --- | --- | --- |
| `PveConfigError` | `config` | a credential or a parameter value is missing or unusable |
| `PveConnectionError` | `connection` | DNS, TCP, TLS or a request timeout; `url` |
| `PveAuthError` | `auth` | the API rejected the credentials; `tier` |
| `PveTierError` | `tier` | the call needs a credential this client does not hold; `required`, `available` |
| `PvePermissionError` | `permission` | 403 with accepted credentials; `method`, `path`, `tier` |
| `PveNotFoundError` | `not-found` | 404, an unknown path or a missing guest |
| `PveApiError` | `api` | any other non-2xx; `status`, `errors` per parameter |
| `PveTaskError` | `task` | a worker task failed, or is still running after the wait (`timedOut`); `upid`, `exitStatus`, `log` |
| `PveTimeoutError` | `timeout` | a poll gave up: a run state, the agent, a screen, a guest command; `what`, `waitedMs` |
| `PvePropertyError` | `property` | a property string does not fit its format |
| `PveConsoleError` | `console` | a console transport or protocol failure, or a refused login |
| `GuestCommandError` | `guest-command` | a command inside a guest exited non-zero; `vmid`, `exitCode`, `stdout`, `stderr` |
| `PveShellError` | `shell` | the root shell failed; `shell` names which way |

`PveShellError` subclasses: `PveShellCredentialError`,
`PveShellTransportError`, `PveShellPolicyError`, `PveShellCommandError`
(`exitCode`, `stdout`, `stderr`) and `PveShellTimeoutError` (`timeoutMs`,
`partialOutput`), the one timeout class that is not `PveTimeoutError`.

## What needs root@pam

An API token reaches every endpoint except the twelve below. Their handlers
compare the caller against the string `root@pam`, and a root-owned token is
`root@pam!name`, so the call needs `PVE_USER=root@pam` and `PVE_PASSWORD`:

```
POST   /cluster/config                    POST   /cluster/config/join
POST   /cluster/config/nodes/{node}       DELETE /cluster/config/nodes/{node}
POST   /nodes/{node}/execute              PUT    /nodes/{node}/disks/wipedisk
GET    /cluster/backup-info               POST   /nodes/{node}/storage/{storage}/content/{volume}
POST   /cluster/acme/account              GET    /cluster/acme/account/{name}
PUT    /cluster/acme/account/{name}       DELETE /cluster/acme/account/{name}
```

`POST /nodes/{node}/termproxy` is gated the same way: any other caller gets a
`/bin/login` password prompt, so `node.shell` without an SSH key needs the
root@pam ticket.

The same comparison gates parameters on endpoints a token otherwise reaches:
`skiplock`, `lock`, `hookscript`, QEMU `args`, a `serial[n]` on a host
device, raw `host=` in `usb[n]` and `hostpci[n]`, `migration_type`,
`migration_network`, LXC bind and device `mp[n]` and `rootfs`, `dev[n]`, and
`features` past `nesting`. The client throws `PveTierError` naming the
parameter before sending when no root ticket is configured;
`cluster.client.requiredTier(method, path, params)` answers without sending.

Five `/access` endpoints refuse a token outright: `POST /access/ticket`,
`PUT /access/password`, and the three TFA writes.

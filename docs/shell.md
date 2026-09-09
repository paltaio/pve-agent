# The shell layer

Everything a Proxmox cluster can only be told to do from a root shell on a
node. See [api-gaps.md](api-gaps.md) for what that covers.

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()

const shell = await cluster.node('pve1').shell
console.log(shell.kind, shell.transport.description)
// ssh  ssh root@pve1

await shell.output('pveversion -v')
```

The shell opens on the first `await` and is shared from then on, per node and
per cluster. `cluster.close()` closes every one. A failed open is not cached,
so the next call tries again.

## Transports

| | SSH | termproxy |
| --- | --- | --- |
| Credential | A key authorised for root on the node | A `root@pam` login ticket |
| Exit codes | The command's own | Parsed out of markers the transport wraps the command in |
| Streams | stdout and stderr separate | stderr goes through a temporary file on the node |
| Binary | Safe in both directions | Base64 through the pty |
| Transfer | `scp` | Base64 in 1024-character pieces, capped at 1 MiB |
| Command line | Any length | 4096 bytes after wrapping |

`transport: 'auto'`, the default, probes SSH first and falls back to termproxy
when the client holds a `root@pam` ticket. Force one with `transport: 'ssh'`
or `'termproxy'`.

`POST /nodes/{node}/termproxy` hands anyone who is not literally `root@pam` a
`/bin/login` password prompt where a shell would be, an API token included,
so the fallback serves a `root@pam` ticket and nothing else.

With neither credential, opening the shell throws `PveShellCredentialError`
with a message naming both ways to fix it.

## Configuring the shell

Settings go on the cluster and apply to every node shell it opens:

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect({
	shell: {
		transport: 'auto',
		ssh: {
			host: '192.0.2.10', // points every node shell at one address
			user: 'root',
			port: 22,
			identityFile: '/home/me/.ssh/pve',
			strictHostKeyChecking: 'accept-new',
			controlPath: '~/.ssh/cm-%C', // reuse one TCP session across commands
			controlPersistSeconds: 60,
			connectTimeoutSeconds: 10,
			defaultTimeoutMs: 120_000,
		},
		policy: { destructive: 'refuse' },
	},
})
```

Without `controlPath`, SSH opens a connection per command. Set it for a script
that runs many; keep the socket under `~/.ssh`, a directory only you can
write, and let `%C` name it. `ssh.host` defaults to the node name, so it works when the node
names resolve.

## Running commands

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()
const shell = await cluster.node('pve1').shell

const result = await shell.run('systemctl is-active pvestatd', {
	timeoutMs: 30_000,
	input: 'stdin bytes',
	check: false,
	env: { LC_ALL: 'C' },
	cwd: '/tmp',
})
console.log(result.exitCode, result.stdout, result.stderr, result.durationMs)

await shell.output('hostname -f') // trimmed stdout, throws on non-zero
```

`run` returns the exit code; `check: true` and `output` throw
`PveShellCommandError` on a non-zero one. A command that passes `timeoutMs` throws
`PveShellTimeoutError` carrying the output read so far. `env` exports the
variables and `cwd` changes directory before the command runs; a `cd` that
fails ends the line with its own exit code.

Everything the layer sends is one command line interpreted by a POSIX shell on
the node, so quote every value that comes from outside:

```ts
import pve, { shHeredoc, shJoin, shQuote } from 'pve-agent'

await using cluster = await pve.connect()
const shell = await cluster.node('pve1').shell
const pattern = 'error'
const dataset = 'rpool/data'

await shell.run(`grep -F -- ${shQuote(pattern)} /var/log/syslog`)
await shell.run(shJoin(['zfs', 'get', 'compression', dataset]))
await shell.run(`cat > /etc/motd ${shHeredoc('welcome\n')}`)
```

`shQuote` refuses a value containing a NUL byte, because `execve` stops there
and the node would act on the truncated value. A leading dash survives
quoting, so an operand built from a value still needs a `--` in front of it.
`shHeredoc` carries content verbatim, with a terminator no line of the
content equals.

Two other checks throw where quoting cannot help. A parameter that goes into
a command line as a bare number is checked with `Number.isSafeInteger`, so a
numeric string from a JavaScript caller throws before it reaches the command
line. A name joined to a fixed directory, such as a unit file, a drop-in, a
repository file or a keyring, has to be one path component: empty, `.`,
`..`, `/` and NUL are all refused. Each of these throws
`PveShellPolicyError`.

## Files

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()
const shell = await cluster.node('pve1').shell

await shell.upload('./local.conf', '/etc/remote.conf')
await shell.download('/var/log/syslog', './syslog')
```

Both replace the target. Over SSH they run `scp`; over termproxy the bytes go
through the pty as base64, with the upload decoded into a temporary file next
to the target and renamed over it. The policy does not see either.

## The policy

The policy reads each command line before it goes to the node. It is a rail
for a caller that builds command lines from generated text. A shell has
enough indirection that a determined caller can hide anything from it.

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect({
	shell: {
		policy: {
			deny: ['pvecm', /\bmount\b/],
			allow: ['zfs', 'zpool', 'systemctl', 'journalctl'],
			destructive: 'refuse',
		},
	},
})
```

- `deny` is checked first. A string names a program and matches when any
  command in the line runs it, by base name, on either side of a pipe, `;`,
  `&&`, `||` or `&`. A RegExp is tested against the whole line.
- `destructive`, `'refuse'` by default, applies `DESTRUCTIVE_PATTERNS`:
  `rm -r` and `rm -f`, `shred`, `find -delete`, `zpool destroy`, `labelclear`,
  `split`, `remove`, `detach`, `offline` and `replace`, `zfs destroy`,
  `rollback` and `change-key`, `mkfs`, partition table tools, `dd of=`, LVM
  removal, LUKS format and key changes, `mdadm` array changes, `qm destroy`
  and `pct destroy`, `pvecm delnode`, `apt remove`, `purge` and `autoremove`,
  `dpkg --purge`, `reboot`, `poweroff`, `halt` and `shutdown` in command
  position, the `systemctl` power verbs, a redirect onto a block device,
  `mkswap`, `swapoff` and `pvesm free`. `destructive: 'allow'` lets them
  through.
- `allow`, when set, refuses any command no pattern matches, and refuses a
  line holding a command substitution or a process substitution outright,
  since those run programs the check cannot see.

A refusal throws `PveShellPolicyError` before anything is spawned, carrying
`command` and `reason`. The helpers go through the same check, so
`shell.zfs.destroyDataset` and `shell.apt.remove` are refused on a default
shell. Open a second shell for the destructive part of a script:

```ts
import { NodeShell } from 'pve-agent'

const shell = await NodeShell.open({ node: 'pve1', policy: { destructive: 'allow' } })
try {
	await shell.zfs.destroyDataset('rpool/data/scratch', { recursive: true })
} finally {
	await shell.close()
}
```

Decide without running anything:

```ts
import { CommandPolicy, commandPrograms } from 'pve-agent'

const policy = new CommandPolicy({ allow: ['zfs'] })
console.log(policy.explain('zfs destroy -r rpool/data')) // { allowed: false, reason: '...' }
console.log(commandPrograms('zfs list | grep data')) // ['zfs', 'grep']
```

## ZFS

The API covers pool create and destroy. Everything else is here.

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()
const shell = await cluster.node('pve1').shell

await shell.zfs.listPools() // name, sizeBytes, allocatedBytes, freeBytes, health, capacityPercent
await shell.zfs.poolStatus('rpool') // device tree, errors, scan line
await shell.zfs.listDatasets({ target: 'rpool', recursive: true, types: ['filesystem'] })
await shell.zfs.listSnapshots('rpool/data', { recursive: true })
await shell.zfs.getProperties('rpool/data', ['compression', 'used'])
await shell.zfs.getPoolProperties('rpool')

await shell.zfs.createDataset('rpool/data/app', { properties: { compression: 'zstd' } })
await shell.zfs.createDataset('rpool/data/vol', { volumeSizeBytes: 8 * 1024 ** 3 })
await shell.zfs.setProperty('rpool/data/app', 'quota', '100G')
await shell.zfs.setPoolProperty('rpool', 'autotrim', 'on')
await shell.zfs.renameDataset('rpool/data/app', 'rpool/data/app2')
await shell.zfs.snapshot('rpool/data/app2@before', { recursive: true })
await shell.zfs.clone('rpool/data/app2@before', 'rpool/data/app3')

await shell.zfs.scrub('rpool')
await shell.zfs.scrubStatus('rpool')
await shell.zfs.trim('rpool')
await shell.zfs.importPool('tank', { force: true, altroot: '/mnt/tank' })
await shell.zfs.exportPool('tank', { force: true })
await shell.zfs.addVdev('rpool', ['mirror', '/dev/sdc', '/dev/sdd'])
await shell.zfs.attachDevice('rpool', '/dev/sdc', '/dev/sdd')
await shell.zfs.onlineDevice('rpool', '/dev/sdc', { expand: true })
await shell.zfs.upgradePool('rpool')

await shell.zfs.loadKey('rpool/secure', { keyLocation: 'file:///root/key' })
await shell.zfs.unloadKey('rpool/secure')

await shell.zfs.sendToFile('rpool/data@snap', '/tmp/snap.zfs')
await shell.zfs.receiveFromFile('rpool/restored', '/tmp/snap.zfs')
```

`destroyDataset`, `rollback`, `changeKey`, `replaceDevice`, `detachDevice`
and `offlineDevice` match the destructive patterns and need a shell with
`destructive: 'allow'`. `destroyDataset` refuses a pool root: that is `zpool
destroy`, which the API covers.

## systemd

The node API's service endpoint takes a fixed list of PVE units, listed in
[api-gaps.md](api-gaps.md). Any other unit, and every unit file, drop-in,
timer and mask, is here.

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()
const shell = await cluster.node('pve1').shell

await shell.systemd.listUnits({ type: 'service', state: 'failed' })
const status = await shell.systemd.status('nginx.service')
console.log(status.activeState, status.subState, status.unitFileState, status.mainPid, status.restarts)
await shell.systemd.show('nginx.service', ['MainPID', 'ActiveState'])
await shell.systemd.isActive('nginx')
await shell.systemd.isEnabled('nginx')
await shell.systemd.listTimers()

await shell.systemd.start('nginx')
await shell.systemd.stop('nginx')
await shell.systemd.restart('nginx')
await shell.systemd.reload('nginx')
await shell.systemd.enable('nginx', { now: true })
await shell.systemd.disable('nginx', { now: true })
await shell.systemd.mask('nginx')
await shell.systemd.unmask('nginx')
await shell.systemd.daemonReload()

const unitText = '[Unit]\nDescription=app\n[Service]\nExecStart=/opt/app\n'
await shell.systemd.writeUnit('app.service', unitText)
await shell.systemd.writeUnit('app.service', '[Service]\nNice=10\n', { dropIn: 'override' })
await shell.systemd.readUnit('app.service')
await shell.systemd.removeUnit('app.service', { reload: true })
await shell.systemd.journal({ unit: 'nginx.service', lines: 200, since: '-1h', priority: 'err' })
```

`systemctl show` is the query, because its `Key=Value` output parses without
guessing at column widths. A unit file lands under `/etc/systemd/system`, a
drop-in under `<unit>.d/<name>.conf`, and both reload systemd unless
`reload: false`.

## Packages

The API reports what an update would bring and can run `apt-get update`. It
cannot install, upgrade or remove anything.

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()
const shell = await cluster.node('pve1').shell

await shell.apt.update()
await shell.apt.listUpgradable() // { name, suite, currentVersion, newVersion, architecture }
await shell.apt.pendingUpgrades() // { action, name, currentVersion, newVersion, architecture }
await shell.apt.install(['htop', 'jq'], { recommends: false })
await shell.apt.upgrade()
await shell.apt.distUpgrade()
await shell.apt.policy('pve-manager')
await shell.apt.show('pve-manager')
await shell.apt.search('^pve-', { namesOnly: true })
await shell.apt.hold(['pve-kernel-6.14'])
await shell.apt.unhold(['pve-kernel-6.14'])
await shell.apt.listHolds()
await shell.apt.installedVersion('pve-manager')
await shell.apt.listInstalled('pve-*')

await shell.apt.addRepository('extra.sources', 'Types: deb\nURIs: https://example.com/debian\n')
await shell.apt.addKeyring('vendor.gpg', new Uint8Array([0x99]))
```

Every apt call runs non-interactively and keeps the installed version of a
conffile when the package ships a changed one, because a prompt on a node
with no terminal never gets answered. `remove`, `purge` and `autoremove` match
the destructive patterns and need a shell with `destructive: 'allow'`.

## qm

The `qm` subcommands with no endpoint, and the lifecycle for a caller that
already holds a shell:

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()
const shell = await cluster.node('pve1').shell

await shell.qm.list() // { vmid, name, status, memoryMb, bootDiskGb, pid }
await shell.qm.config(100)
await shell.qm.status(100)
await shell.qm.start(100)
await shell.qm.shutdown(100, { timeoutSeconds: 60, forceStop: true })
await shell.qm.set(100, { memory: 4096 })
await shell.qm.sendkey(100, 'ctrl-alt-delete')
await shell.qm.monitor(100, 'info status')
await shell.qm.guestExec(100, ['uname', '-a'])

await shell.qm.importDisk(9001, '/mnt/images/disk.qcow2', 'local-zfs', {
	format: 'raw',
	targetDisk: 'scsi1',
	timeoutMs: 3_600_000,
})
await shell.qm.importOvf(9001, '/mnt/images/appliance.ovf', 'local-zfs')
await shell.qm.showCommand(100, { pretty: true }) // the generated kvm command line
await shell.qm.rescan({ vmid: 100, dryRun: true })
await shell.qm.nbdStop(100)
await shell.qm.enrollEfiKeys(100)
await shell.qm.cleanup(100, { cleanShutdown: true })
await shell.qm.unlock(100)
```

The API can only import a volume that already exists on a PVE storage, so an
image sitting anywhere else on the node goes through `importDisk`. It copies
the whole image; the timeout defaults to an hour.

## pct

Container-scoped commands take the vmid:

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()
const shell = await cluster.node('pve3').shell

await shell.pct.list() // { vmid, status, lock, name }
await shell.pct.config(110)
await shell.pct.status(110)
await shell.pct.start(110)
await shell.pct.shutdown(110, { timeoutSeconds: 60, forceStop: true })

await shell.pct.exec(110, 'apk info') // through sh -c inside the container
await shell.pct.execArgv(110, ['/usr/bin/env'], { keepEnv: false })
await shell.pct.push(110, '/tmp/on-node', '/opt/in-container', { perms: '0644', user: 0, group: 0 })
await shell.pct.pull(110, '/var/log/messages', '/tmp/on-node')
await shell.pct.pushLocalFile(110, './app.tar', '/opt/app.tar')
await shell.pct.pullToLocalFile(110, '/opt/report.json', './report.json')

await shell.pct.df(110) // mountPoint, volume, size, used, available, usePercent, path
await shell.pct.unlock(110)
await shell.pct.fsck(110)
await shell.pct.fstrim(110)
await shell.pct.rescan({ vmid: 110, dryRun: true })
await shell.pct.mount(110)
await shell.pct.unmount(110)
```

`pct exec` attaches to the container and runs `sh -c`, so the exit code is
the command's own and, over SSH, stdout and stderr stay apart. A stopped
container makes `pct` exit 255 with "container is not running" on stderr.
`ct.exec` on a container handle is `shell.pct.exec` with the vmid filled in.

`pct unlock` is the only way to clear a container's config lock: the config
endpoint has no `skiplock` and checks the lock on every write. Clearing a
lock while the operation that set it is still running lets two writers touch
the same config, so check what is in flight first.

## Errors

Every class extends `PveShellError`, whose `kind` is `shell` and whose `shell`
field says which failure it was.

| Class | `shell` | Raised when |
| --- | --- | --- |
| `PveShellCredentialError` | `credential` | No SSH key and no `root@pam` ticket |
| `PveShellTransportError` | `transport` | The transport could not open, died mid-session, or a termproxy limit was passed |
| `PveShellPolicyError` | `policy` | The policy refused the command, or a value failed a quoting check |
| `PveShellCommandError` | `command` | The command ran and exited non-zero, with `check` set |
| `PveShellTimeoutError` | `timeout` | No result before the deadline; `partialOutput` holds what arrived |

## Opening a shell without a cluster

```ts
import { NodeShell, PveClient } from 'pve-agent'

const shell = await NodeShell.open({
	node: 'pve1',
	ssh: { host: '192.0.2.10', identityFile: '/home/me/.ssh/pve' },
	policy: { allow: ['zpool', 'zfs'] },
})
try {
	console.log(await shell.output('zpool list'))
} finally {
	await shell.close()
}

const client = PveClient.fromEnv()
const remote = await NodeShell.open({ node: 'pve1', transport: 'termproxy', client })
await remote.close()
client.close()
```

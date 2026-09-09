# Storage

Three separate things, in three separate places:

| | Where | What it is |
| --- | --- | --- |
| The definition | `cluster.api.storage` | An entry in `/etc/pve/storage.cfg`: type, location, content types, which nodes may use it |
| What is on it | `node.api.storage` | Volumes, free space, uploads, backups, pruning |
| The disk under it | `node.api.disks` | Physical disks, and the LVM, ZFS or directory backend built on them |

## Storage definitions

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()
const storage = cluster.api.storage

await storage.list()
await storage.list({ type: 'zfspool' })
const local = await storage.get('local-zfs')
console.log(local.type, local.content, local.nodes, local.shared, local.pool)

await storage.create({
	storage: 'backup-nfs',
	type: 'nfs',
	server: '10.0.0.9',
	export: '/srv/backup',
	content: 'backup',
	nodes: 'pve1,pve2',
	'prune-backups': 'keep-daily=7,keep-weekly=4',
})
await storage.update('backup-nfs', { disable: true })
await storage.delete('backup-nfs')
```

Deleting a definition removes the entry and leaves the data in place.

Creating a ZFS pool storage assumes the pool already exists on the node.
`node.api.disks.createZfs` builds one from raw disks; anything past a plain
create, such as importing a pool, adding a vdev or encryption, has no API and
goes through `shell.zfs`.

Build the definition from what a server offers rather than guessing:

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()
const scan = cluster.node('pve1').api.scan
const required = (name: string): string => {
	const value = process.env[name]
	if (!value) throw new Error(`${name} is not set`)
	return value
}

await scan.nfs('10.0.0.9')
await scan.cifs({ server: '10.0.0.9', username: 'svc', password: required('CIFS_PASSWORD') })
await scan.iscsi('10.0.0.9:3260')
await scan.lvm()
await scan.lvmThin('pve')
await scan.zfs()
await scan.pbs({ server: 'pbs.example.com', username: 'svc@pbs', password: required('PBS_PASSWORD') })
```

These read only. Nothing is configured until `cluster.api.storage.create`
runs.

## Volumes

A volume id is `storage:path`, such as `local:iso/debian-13.iso` or
`tank-vms:subvol-110-disk-0`. It goes into the URL encoded, which the methods
here do.

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()
const storage = cluster.node('pve1').api.storage

await storage.list({ content: 'images', enabled: true })
await storage.status('local-zfs') // total, used, avail, active, enabled
await storage.content('local', { content: 'iso' })
await storage.content('local-zfs', { vmid: 100 })
await storage.volume('local-zfs', 'local-zfs:vm-100-disk-0')

const volid = await storage.allocate('local-zfs', {
	vmid: 100,
	filename: 'vm-100-disk-3',
	size: '16G',
	format: 'raw',
})
await storage.updateVolume('backup', 'backup:backup/vzdump-qemu-100-2026_09_01-03_00_00.vma.zst', {
	notes: 'keep',
	protected: true,
})
await cluster.waitForTask(await storage.deleteVolume('local-zfs', volid))
```

Copying a volume to another storage or node is one of the twelve endpoints
registered with no permissions block, so it needs a `root@pam` ticket:

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()

const upid = await cluster.node('pve1').api.storage.copyVolume('local-zfs', 'local-zfs:vm-100-disk-0', {
	target: 'tank-vms',
	target_node: 'pve2',
})
await cluster.waitForTask(upid)
```

## Getting files onto a storage

Two ways, and they take different things.

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()
const storage = cluster.node('pve1').api.storage

// Upload from this machine
const file = Bun.file('./debian-13.iso')
await cluster.waitForTask(
	await storage.upload('local', file, {
		content: 'iso',
		filename: 'debian-13.iso',
		checksum: 'sha256-hex',
		'checksum-algorithm': 'sha256',
	}),
)

// Let the node fetch it
const upid = await storage.downloadUrl('local', {
	content: 'iso',
	filename: 'debian-13.iso',
	url: 'https://cdimage.debian.org/debian-cd/current/amd64/iso-cd/debian-13.iso',
	checksum: 'sha256-hex',
	'checksum-algorithm': 'sha256',
})
await cluster.waitForTask(upid)
```

`upload` takes a `Blob` and streams it as multipart; the node copies it over
SSH first when the storage is not local to the node that took the request.
`downloadUrl` runs the download on the node, so the bytes never pass through
this process. Both return a UPID.

Container templates are `vztmpl` content:

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()
const storage = cluster.node('pve1').api.storage

const templates = await storage.content('local', { content: 'vztmpl' })
console.log(templates.map((volume) => volume.volid))
await cluster.waitForTask(
	await storage.downloadUrl('local', {
		content: 'vztmpl',
		filename: 'debian-13-standard_13.0-1_amd64.tar.zst',
		url: 'http://download.proxmox.com/images/system/debian-13-standard_13.0-1_amd64.tar.zst',
	}),
)
```

## Backups

Running a backup at once is a node call; scheduling one is cluster config.

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()
const node = cluster.node('pve1')

const upid = await node.api.backup.run({
	vmid: '100,110',
	storage: 'backup',
	mode: 'snapshot',
	compress: 'zstd',
	'notes-template': '{{guestname}}',
})
await cluster.waitForTask(upid)

await node.api.backup.defaults({ storage: 'backup' })
await node.api.backup.extractConfig('backup:backup/vzdump-qemu-100-2026_09_01-03_00_00.vma.zst')
```

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()

await cluster.api.backup.create({
	schedule: '02:00',
	storage: 'backup',
	mode: 'snapshot',
	all: true,
	'prune-backups': 'keep-daily=7',
})
await cluster.api.backup.includedVolumes('backup-1')
await cluster.api.backup.notBackedUp()
```

`notBackedUp` reads `/cluster/backup-info/not-backed-up`, which a token
reaches. `GET /cluster/backup-info` itself is one of the twelve root-only
endpoints.

### Pruning

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()
const storage = cluster.node('pve1').api.storage

const preview = await storage.prunePreview('backup', { 'prune-backups': 'keep-daily=7', vmid: 100 })
for (const candidate of preview) console.log(candidate.volid, candidate.mark)
const upid = await storage.pruneBackups('backup', { 'prune-backups': 'keep-daily=7' })
await cluster.waitForTask(upid)
```

Preview first. `prunePreview` lists every backup with the `keep`, `remove`,
`protected` or `renamed` decision it would make.

### Restoring single files

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()
const storage = cluster.node('pve1').api.storage
const volid = 'pbs:backup/vm/100/2026-09-01T03:00:00Z'

const entries = await storage.fileRestoreList('pbs', volid, '/')
const etc = entries.find((entry) => entry.text === 'etc')
if (etc) {
	const signed = await storage.fileRestoreDownload('pbs', volid, etc.filepath, { tar: true })
	const response = await fetch(signed.url, { headers: signed.headers })
	await Bun.write('./etc.tar', await response.arrayBuffer())
}
```

The response is the file itself, so `fileRestoreDownload` returns
`{ url, headers }` and leaves the fetch to you. A directory comes back as a
zip, or as a tar stream with `tar: true`. `filepath` is `/` for the top
level and the base64 path of an entry below that.

Restoring a whole guest is a create call with `archive` on a VM or
`restore: true` on a container. See [guests.md](guests.md).

## Local disks

Everything here except the list calls is destructive and runs as a worker
task, so the return value is a UPID.

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()
const disks = cluster.node('pve1').api.disks

for (const disk of await disks.list({ type: 'unused' })) {
	console.log(disk.devpath, disk.size, disk.model, disk.used, disk.health)
}
await disks.smart('/dev/sda', { healthonly: true })
await cluster.waitForTask(await disks.initGpt('/dev/sdb'))
```

`PUT /nodes/{node}/disks/wipedisk` is one of the twelve root-only endpoints
and needs a `root@pam` ticket:

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()

await cluster.waitForTask(await cluster.node('pve1').api.disks.wipe('/dev/sdb'))
```

Building a backend on a disk:

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()
const disks = cluster.node('pve1').api.disks

await cluster.waitForTask(
	await disks.createZfs({
		name: 'tank',
		devices: '/dev/sdb,/dev/sdc',
		raidlevel: 'mirror',
		compression: 'zstd',
		add_storage: true,
	}),
)
await cluster.waitForTask(await disks.createLvm({ name: 'vg0', device: '/dev/sdb' }))
await cluster.waitForTask(await disks.createLvmThin({ name: 'thin0', device: '/dev/sdb' }))
await cluster.waitForTask(
	await disks.createDirectory({ name: 'media', device: '/dev/sdb', filesystem: 'ext4' }),
)

await disks.listZfs()
const tank = await disks.getZfs('tank')
console.log(tank.state, tank.scan, tank.children.map((vdev) => vdev.name))
await cluster.waitForTask(await disks.deleteZfs('tank', { 'cleanup-config': true }))
```

`add_storage: true` also writes the storage definition, saving a separate
`cluster.api.storage.create`.

### What ZFS has no API for

Create and destroy is the whole of it; every other ZFS operation goes through
`shell.zfs`. [api-gaps.md](api-gaps.md) lists what is missing and
[shell.md](shell.md) the full ZFS surface.

## Replication

Replication needs a ZFS storage with the same name on source and target.

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()

await cluster.api.replication.create({
	id: '110-0',
	type: 'local',
	target: 'pve2',
	schedule: '*/15',
})
const node = cluster.node('pve3')
await node.api.replication.list({ guest: 110 })
const status = await node.api.replication.status('110-0')
console.log(status.lastSync, status.failCount, status.error)
await node.api.replication.log('110-0', { limit: 200 })
await cluster.waitForTask(await node.api.replication.runNow('110-0'))
```

The job definition is cluster config; the per-run state and log live on the
node.

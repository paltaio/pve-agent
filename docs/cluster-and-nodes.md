# Cluster and nodes

## Cluster state

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()

const status = await cluster.api.status()
// one row with type 'cluster', then one per node
const quorate = status.find((row) => row.type === 'cluster')?.quorate === true
console.log(quorate)
```

`quorate: false` on the cluster row means writes to `/etc/pve` are blocked;
check it before anything that changes cluster config. PVE
sends an integer; the row hands back a boolean, with the untouched response
under `raw`.

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()

await cluster.api.resources() // guests, nodes, storages and pools in one call
await cluster.api.resources({ type: 'storage' })
await cluster.api.guestNodes() // Map of vmid to { vmid, type, node }
await cluster.api.tasks() // recent tasks from every node
await cluster.api.log({ max: 200 }) // cluster log, newest first
await cluster.api.nextId()
```

`/cluster/resources` is the cache pvestatd refreshes every few seconds. It is
the cheapest way to map a vmid to its node and the wrong place to read the
current state of something you just changed.

### Datacenter options

```ts
import pve, { formatConfigValue } from 'pve-agent'

await using cluster = await pve.connect()

const options = await cluster.api.getOptions()
console.log(options['keyboard'], options['migration'])

const migration = formatConfigValue('PUT', '/cluster/options', 'migration', {
	type: 'secure',
	network: '10.10.12.0/24',
})
await cluster.api.setOptions({ migration })
```

Several fields are property strings. Build them rather than concatenating.
Without `Sys.Audit` on `/` the read comes back partial.

## Nodes

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()

for (const entry of await cluster.nodes()) {
	console.log(entry.node, entry.status, entry.uptime, entry.maxmem)
}

const node = cluster.node('pve1')
const status = await node.status()
console.log(status.uptime, status.loadavg, status.kversion, status.pveversion, status['boot-info'])
await node.api.version()
await cluster.list({ node: 'pve1', excludeTemplates: true })
```

Most node endpoints carry `proxyTo: 'node'`, so whichever node the client
talks to forwards the call. A node that is not a cluster member yet cannot be
reached that way and needs its own client:

```ts
import { NodeApi, PveClient } from 'pve-agent'

const client = PveClient.fromEnv({ host: '192.0.2.12' })
const joining = new NodeApi(client, 'pve3')
console.log(await joining.version())
client.close()
```

### Node settings

The node config is a short fixed set: `acme`, `acmedomain[n]`,
`ballooning-target`, `description`, `location`, `startall-onboot-delay` and
`wakeonlan`. Nothing about the kernel, sysctls or boot parameters is
reachable.

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()
const node = cluster.node('pve1')

await node.api.getConfig()
await node.api.setConfig({ description: 'rack 2, top', wakeonlan: 'mac=aa:bb:cc:dd:ee:ff' })

await node.api.getDns()
await node.api.setDns({ search: 'lab.example.com', dns1: '10.0.0.1' })

const hosts = await node.api.getHosts()
await node.api.setHosts(`${hosts.data}\n10.0.0.9 extra\n`, { digest: hosts.digest })

await node.api.getTime()
await node.api.setTimezone('Europe/Madrid')
```

`/etc/hosts` has no per-entry call. Read it, edit the text, send all of it
back, and pass the `digest` from the read so a concurrent change is caught
rather than overwritten. The clock itself is not settable through the API; it
comes from chrony or systemd-timesyncd.

### Logs and diagnostics

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()
const node = cluster.node('pve1')

await node.api.syslog({ service: 'pvestatd', limit: 200 })
await node.api.journal({ lastentries: 500, unit: 'pve-cluster.service' })
await node.api.report() // the node's own diagnostic dump, one large string
await node.api.capabilities() // machine types, CPU models, flags
await node.api.netstat()
await node.api.hardware.listPci()
await node.api.hardware.listUsb()
await node.api.certificates.info()
```

### Power and bulk actions

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()
const node = cluster.node('pve1')

await node.api.reboot() // guests are not shut down first
await node.api.shutdown()
await node.api.wakeOnLan() // runs on another node, so it works while this one is off

await cluster.waitForTask(await node.api.startAll({ force: true }))
await cluster.waitForTask(await node.api.stopAll({ timeout: 180 }))
await cluster.waitForTask(await node.api.suspendAll())
await cluster.waitForTask(await node.api.migrateAll({ target: 'pve2' }))
```

`migrateAll` is the way to empty a node before maintenance.

Cluster-wide equivalents walk every selected guest with a pool of workers.
`vms` is a vmid list; leaving it out means every guest the caller may act on:

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()

await cluster.waitForTask(await cluster.api.bulk.start({ vms: [100, 101, 110] }))
await cluster.waitForTask(await cluster.api.bulk.shutdown({ 'max-workers': 4, timeout: 120 }))
await cluster.waitForTask(await cluster.api.bulk.migrate({ target: 'pve2', online: true }))
await cluster.waitForTask(await cluster.api.bulk.suspend({ 'to-disk': true }))
```

### Services

```ts
import pve, { isNodeService, NODE_SERVICES } from 'pve-agent'

await using cluster = await pve.connect()
const node = cluster.node('pve1')

console.log(NODE_SERVICES.length, isNodeService('nginx'))
await node.api.services.list()
await node.api.services.state('pvestatd')
await cluster.waitForTask(await node.api.services.restart('pvestatd'))
await cluster.waitForTask(await node.api.services.reload('pveproxy'))
```

The API knows a fixed list of systemd units, `NODE_SERVICES`, and refuses any
other name.
`pveproxy`, `pvedaemon` and `pve-cluster` cannot be stopped, and a restart of
`pveproxy` or `pvedaemon` drops in-flight API connections, including the one
issuing the call. Anything outside the list goes through `shell.systemd`.

### The batch endpoint

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()

const results = await cluster.node('pve1').api.execute([
	{ path: 'qemu/100/status/current', method: 'GET' },
	{ path: 'qemu/101/status/current', method: 'GET' },
])
for (const result of results) console.log(result.status, result.data ?? result.message)
```

Each command names an API path below `nodes/{node}/`, and the node runs them
in order, re-checking permissions for each. A failing command does not stop
the rest; its entry carries `status` and `message` in place of `data`.
Nothing outside the API is reachable.

This is one of the twelve endpoints registered with no permissions block, so
it needs a `root@pam` ticket. An API token cannot pass, however privileged.

## High availability

A resource id is `vm:100` or `ct:110`. Every write changes cluster config and
takes effect through the HA manager, so the call returns when the config is
written, not when the resource has moved.

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()
const ha = cluster.api.ha

await ha.listResources({ type: 'vm' })
await ha.createResource({ sid: 'vm:100', state: 'started', max_restart: 2 })
await ha.updateResource('vm:100', { state: 'stopped' })
await ha.migrate('vm:100', 'pve2')
await ha.relocate('vm:100', 'pve2')
await ha.deleteResource('vm:100', { purge: true })

await ha.statusCurrent()
await ha.managerStatus()
await ha.disarm('freeze')
await ha.arm()
```

PVE 9 replaced HA groups with HA rules. On a cluster whose groups have been
migrated, every group endpoint answers 500 with "ha groups have been migrated
to rules", so `listGroups` and the rest only work on a cluster still carrying
an unmigrated `/etc/pve/ha/groups.cfg`. Write node placement as a
node-affinity rule:

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()
const ha = cluster.api.ha

await ha.createRule({
	type: 'node-affinity',
	rule: 'db-on-pve1',
	resources: 'vm:100',
	nodes: 'pve1:2,pve2:1',
	strict: true,
})
await ha.createRule({
	type: 'resource-affinity',
	rule: 'db-apart',
	resources: 'vm:100,vm:101',
	affinity: 'negative',
})
for (const rule of await ha.listRules({ type: 'node-affinity' })) {
	if (rule.type === 'node-affinity') console.log(rule.rule, rule.nodes, rule.strict)
}
```

`HaRuleCreateParams` is a union keyed on `type`, so setting `type` narrows the
rest of the parameters, and `HaRule` narrows the same way on read.

## Corosync membership

The read side answers on a token:

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()

await cluster.api.membership.nodes()
await cluster.api.membership.totem()
await cluster.api.membership.qdevice()
await cluster.api.membership.apiVersion()
const info = await cluster.api.membership.joinInfo()
console.log(info.preferred_node, info.nodelist[0]?.pve_fp)
```

Creating a cluster, joining one and editing the node list are four of the
twelve root-only endpoints and go through the client with a `root@pam`
ticket:

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()

const upid = await cluster.client.post<string>('/cluster/config', {
	clustername: 'lab',
	link0: '10.0.0.21',
})
await cluster.waitForTask(upid)
await cluster.client.delete('/cluster/config/nodes/pve3')
```

A join runs on the node that is joining, which is not a member yet and
cannot be reached through any current member. It needs its own client:

```ts
import pve, { PveClient } from 'pve-agent'

await using cluster = await pve.connect()
const info = await cluster.api.membership.joinInfo()

const joining = PveClient.fromEnv({ host: '192.0.2.12', username: 'root@pam' })
try {
	const upid = await joining.post<string>('/cluster/config/join', {
		hostname: '192.0.2.10',
		password: joining.auth.ticketUsername === undefined ? undefined : process.env['PVE_PASSWORD'],
		fingerprint: info.nodelist[0]?.pve_fp,
	})
	await joining.waitForTask(upid)
} finally {
	joining.close()
}
```

## Users, roles and ACLs

PVE permissions are path based. A role is a named set of privileges; an ACL
entry grants a role on a path to a user, group or token and propagates down
the tree unless `propagate` is turned off. The usual paths are `/`,
`/nodes/<node>`, `/vms/<vmid>`, `/storage/<id>` and `/pool/<id>`.

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()
const access = cluster.access
const required = (name: string): string => {
	const value = process.env[name]
	if (!value) throw new Error(`${name} is not set`)
	return value
}

await access.createGroup({ groupid: 'operators' })
await access.createUser({ userid: 'ops@pve', password: required('OPS_PASSWORD'), groups: 'operators' })
await access.createRole({ roleid: 'GuestDriver', privs: 'VM.Audit,VM.PowerMgmt,VM.Console' })
await access.setAcl({
	path: '/vms/100',
	roles: 'GuestDriver',
	groups: 'operators',
	propagate: true,
})
await access.listAcl()
await access.permissions({ userid: 'ops@pve', path: '/vms/100' })
await access.setAcl({ path: '/vms/100', roles: 'GuestDriver', groups: 'operators', delete: true })
```

API tokens:

```ts
import pve from 'pve-agent'
import { writeFile } from 'node:fs/promises'

await using cluster = await pve.connect()
const access = cluster.access

const created = await access.createToken('automation@pve', 'ci', {
	privsep: false,
	comment: 'scripted work',
})
// The secret is readable this once; write it where only the owner can read it.
await writeFile('ci.env', `PVE_TOKEN_ID=${created.fullTokenId}\nPVE_TOKEN_SECRET=${created.value}\n`, {
	mode: 0o600,
})
await access.listTokens('automation@pve')
await access.updateToken('automation@pve', 'ci', { comment: 'renamed' })
const rotated = await access.regenerateToken('automation@pve', 'ci')
await writeFile('ci.env', `PVE_TOKEN_ID=${rotated.fullTokenId}\nPVE_TOKEN_SECRET=${rotated.value}\n`, {
	mode: 0o600,
})
await access.deleteToken('automation@pve', 'ci')
```

Realms, TFA and passwords:

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()
const access = cluster.access
const required = (name: string): string => {
	const value = process.env[name]
	if (!value) throw new Error(`${name} is not set`)
	return value
}

await access.listRealms()
await access.createRealm({
	realm: 'ldap',
	type: 'ldap',
	server1: 'ldap.example.com',
	base_dn: 'dc=example,dc=com',
	user_attr: 'uid',
})
await cluster.waitForTask(await access.syncRealm('ldap', { 'enable-new': false, 'dry-run': true }))

await access.listUserTfa('ops@pve')
await access.unlockTfa('ops@pve')
await access.changePassword({ userid: 'ops@pve', password: required('OPS_PASSWORD') })
```

`POST /access/ticket`, `PUT /access/password` and the three TFA writes are
registered with `allowtoken 0`. The client switches to the ticket for them on
its own.

## Pools

A pool groups guests and storages so an ACL can be granted once on
`/pool/<id>`:

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()
const pools = cluster.api.pools

await pools.create({ poolid: 'infra', comment: 'shared services' })
await pools.update({ poolid: 'infra', vms: '100,110', storage: 'local-zfs' })
const pool = await pools.get('infra', { type: 'qemu' })
console.log(pool.members?.map((member) => member.vmid))
await pools.update({ poolid: 'infra', vms: '100,110', delete: true })
await pools.delete('infra')
```

Nested pools are written with a slash, `infra/db`. Only the collection
endpoints understand them; the `/pools/{poolid}` forms are deprecated and
break on a nested id, so everything here goes through `/pools` with `poolid`
as a parameter. A guest belongs to one pool at a time, so moving it out of
another pool needs `allow-move`.

## Hardware mappings

A mapping gives one cluster-wide id to a device that has a different address
on each node, so a guest can reference `mapping=gpu0` and stay migratable. A
guest config naming a raw `host=` address needs a `root@pam` ticket; a
`mapping=` entry does not.

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()
const mapping = cluster.api.mapping

await mapping.pci.create({
	id: 'gpu0',
	map: ['node=pve1,path=0000:01:00.0,id=10de:2482'],
})
await mapping.pci.list({ 'check-node': 'pve1' })
await mapping.usb.create({ id: 'yubi', map: ['node=pve1,path=1-4,id=1050:0407'] })
await mapping.dir.create({ id: 'media', map: ['node=pve1,path=/srv/media'] })
await mapping.pci.delete('gpu0')
```

`node.api.hardware.listPci()` and `listUsb()` give you the raw addresses to
build the map from, and `listMdevTypes(id)` the mediated device types a PCI
device offers.

## Notifications and metrics

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()
const notifications = cluster.api.notifications

await notifications.listTargets()
await notifications.gotify.create({ name: 'ops', server: 'https://gotify.example.com', token: 'app-token' })
await notifications.testTarget('ops')
await notifications.createMatcher({
	name: 'backups',
	'match-field': ['exact:type=vzdump'],
	target: ['ops'],
})
await notifications.listMatchers()
await notifications.matcherFields()

const metrics = cluster.api.metrics
await metrics.createServer('influx', { type: 'influxdb', server: '10.0.0.5', port: 8086 })
await metrics.listServers()
await metrics.export({ history: true, 'start-time': Math.floor(Date.now() / 1000) - 300 })
```

The built-in `mail-to-root` target has no config entry and cannot be edited
or removed, but it does appear in `listTargets`.

## Scheduled jobs

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()

await cluster.api.backup.create({ schedule: '02:00', storage: 'backup', mode: 'snapshot', all: true })
await cluster.api.backup.includedVolumes('backup-1')
await cluster.api.backup.notBackedUp()

await cluster.api.replication.create({
	id: '110-0',
	type: 'local',
	target: 'pve2',
	schedule: '*/15',
})
const node = cluster.node('pve3')
await node.api.replication.list({ guest: 110 })
await cluster.waitForTask(await node.api.replication.runNow('110-0'))

await cluster.api.jobs.listRealmSync()
await cluster.api.jobs.analyzeSchedule('mon..fri 02:00', { iterations: 5 })
```

A replication job id is `<vmid>-<number>`. Replication needs a ZFS storage
with the same name on source and target. The job definition is cluster
config; the per-run state and log live on the node.

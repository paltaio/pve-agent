# Networking

## Node interfaces are a staged edit

PVE never edits `/etc/network/interfaces` in place. `create`, `update` and
`deleteInterface` write `/etc/network/interfaces.new` and change nothing on
the running node. `apply` runs `ifreload -a` against the staged file and
promotes it; `revert` deletes it.

So a script that creates a bridge and stops there has changed nothing.

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()
const net = cluster.node('pve1').api.network

await net.create({ iface: 'vmbr1', type: 'bridge', bridge_ports: 'enp2s0', autostart: true })

const pending = await net.staged()
if (pending.changed) {
	console.log(pending.diff)
	await cluster.waitForTask(await net.apply())
}
```

Discard the staged file:

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()

await cluster.node('pve1').api.network.revert()
```

`list` returns the staged file's interfaces once a change is pending, so
reading an interface back after `create` shows it before it exists on the
node. `active` and `exists` come from the running system and stay false for a
staged interface.

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()
const net = cluster.node('pve1').api.network

for (const entry of await net.list({ type: 'bridge' })) {
	console.log(entry.iface, entry.cidr, entry.bridgePorts, entry.active)
}
await net.get('vmbr0')
await net.update('vmbr1', { type: 'bridge', bridge_ports: 'enp2s0 enp3s0' })
await net.deleteInterface('vmbr1')
```

Applying a change on a remote node can cut your own connection to it. Stage,
read the diff, and only then apply. `apply({ regenerateFrr: false })` keeps
the FRR config as it is.

### Bridges, bonds and VLANs

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()
const net = cluster.node('pve1').api.network

await net.create({
	iface: 'bond0',
	type: 'bond',
	slaves: 'enp2s0 enp3s0',
	bond_mode: '802.3ad',
	bond_xmit_hash_policy: 'layer2+3',
})
await net.create({ iface: 'vmbr1', type: 'bridge', bridge_ports: 'bond0', bridge_vlan_aware: true })
await net.create({
	iface: 'vmbr1.20',
	type: 'vlan',
	'vlan-raw-device': 'vmbr1',
	address: '10.20.0.1',
	netmask: '255.255.255.0',
})
```

### What the interface API does not cover

The endpoint has a fixed property set. Hook lines, policy routing, extra
static routes, VRFs, tunnels, ethtool settings and per-interface sysctls have
no parameter here, and an interface this API rewrites drops them. Those
belong to the shell layer, editing the file directly:

```ts
import pve, { shHeredoc } from 'pve-agent'

await using cluster = await pve.connect()
const shell = await cluster.node('pve1').shell

const text = await shell.output('cat /etc/network/interfaces')
const edited = `${text}\n\nauto vmbr2\niface vmbr2 inet manual\n\tbridge-ports none\n`
await shell.run(`cat > /etc/network/interfaces ${shHeredoc(edited)}`, { check: true })
await shell.run('ifreload -a', { check: true })
```

## Guest networking

A guest's interfaces are config keys. See
[property-strings.md](property-strings.md) for building the values.

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()

await cluster.vm(100).configure({ net0: 'virtio,bridge=vmbr0,tag=20,firewall=1' })
await cluster.container(110).configure({ net0: 'name=eth0,bridge=vmbr0,ip=10.0.0.50/24,gw=10.0.0.1' })
```

Reading them back as sub-keys:

```ts
import pve, { formatGuestConfigValue } from 'pve-agent'

await using cluster = await pve.connect()
const vm = cluster.vm(100)

const config = await vm.config()
const net0 = config.nets['net0'] ?? {}
console.log(net0['model'], net0['macaddr'], net0['bridge'], net0['tag'])

await vm.configure({
	net0: formatGuestConfigValue('qemu', 'net0', { ...net0, tag: 30 }),
})
```

What the guest itself reports:

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()

await cluster.vm(100).guest.networkInterfaces() // needs the QEMU guest agent
await cluster.container(110).api.interfaces() // needs no agent; empty for a stopped container
```

## Firewall

Three levels, and each one runs in turn: the datacenter chain, then the node
chain, then the guest chain. Turning the firewall off at one level leaves the
others in place, so read all three when a packet is not going where it
should.

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()
const node = cluster.node('pve1')
const guest = await cluster.guest(100)

// Datacenter
await cluster.api.firewall.setOptions({ enable: 1, policy_in: 'DROP' })
await cluster.api.firewall.rules.list()
await cluster.api.firewall.rules.create({ type: 'in', action: 'ACCEPT', dport: '8006', enable: 1 })

// Node
await node.api.firewall.setOptions({ enable: true })
await node.api.firewall.rules.list()
await node.api.firewall.log({ limit: 200 })

// Guest
await guest.firewall.setOptions({ enable: true, policy_in: 'DROP' })
await guest.firewall.rules.create({ type: 'in', action: 'ACCEPT', dport: '22', enable: 1 })
```

Two behaviours to plan around:

- Create always prepends and ignores `pos`. A new rule lands at the top of
  the chain wherever you asked for it. Move it afterwards with
  `update(0, { moveto: 3 })`.
- A rule created without `enable` is written disabled. Pass `enable: 1`
  unless you meant to stage it.

Rules are addressed by position, and a position shifts when a rule above it
is inserted or removed, so read the list again after a change rather than
caching an index. `digest` on a rule's `raw` goes back as `digest` on an
update or a delete to reject a concurrent edit.

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()
const rules = cluster.api.firewall.rules

const first = await rules.get(0)
console.log(first.pos, first.type, first.action, first.enable)
await rules.update(0, { comment: 'management' })
await rules.update(0, { moveto: 3 })
await rules.delete(0)
```

### Security groups, aliases and IP sets

A security group is a named rule chain a rule references with `type: 'group'`
and its name in `action`. The rule endpoints have the same shape at every
level, so a group is handled with the same object:

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()
const firewall = cluster.api.firewall

await firewall.createGroup({ group: 'web' })
const web = firewall.group('web')
await web.create({ type: 'in', action: 'ACCEPT', dport: '80,443', enable: 1 })
await firewall.rules.create({ type: 'group', action: 'web', enable: 1 })
```

An alias names one address or network; an IP set names a collection of them.
Both are referenced from a rule by name, with a leading `+` for a set.

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()
const firewall = cluster.api.firewall

await firewall.createAlias({ name: 'office', cidr: '203.0.113.0/24' })
await firewall.createIpset({ name: 'admins' })
await firewall.addIpsetEntry('admins', { cidr: '203.0.113.5' })
await firewall.listIpsetEntries('admins')
await firewall.rules.create({ type: 'in', action: 'ACCEPT', source: '+admins', dport: '22', enable: 1 })

await firewall.listMacros()
await firewall.listRefs({ type: 'ipset' })
```

`listRefs` answers what a rule may reference, which is the way to check a
name before writing it into a rule.

The same alias and IP set calls exist per guest under `guest.firewall`.

## Logs

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()
const node = cluster.node('pve1')
const guest = await cluster.guest(100)

const page = await node.api.firewall.log({ start: 0, limit: 100 })
console.log(page.total, page.lines.length)
await guest.firewall.log({ limit: 100, since: 1_756_000_000 })
```

The lines are `PveLogLine[]`, the same `{ n, t }` rows a task log returns.
The node log comes as a page, `{ lines, total }`, with the total the node
reports for paging; a guest log is the rows alone. Only rules with `log` set
appear.

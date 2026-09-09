# Property strings

Many PVE parameters are `key=value,key=value` text:

```
net0:      virtio=BC:24:11:A1:B2:C3,bridge=vmbr0,tag=20,firewall=1
scsi0:     local-zfs:vm-100-disk-0,size=32G,discard=on,ssd=1
mp0:       local-zfs:subvol-110-disk-1,mp=/data,backup=1
migration: type=secure,network=10.10.12.0/24
```

The encoding has no quoting and no escaping. `parse_property_string` on the
node is a plain split on commas, so a value containing a comma cannot be
represented at all; the encoder here refuses one, as the node does. Lists
inside a value use semicolons.

## From a guest config

A guest config comes back with its property strings parsed. `QemuConfig` has
`disks`, `nets`, `unused` and `agent`; `LxcConfig` has `rootfs`, `mounts`,
`nets` and `features`. Everything else stays as text under `raw`.

```ts
import pve, { formatGuestConfigValue, parseGuestConfigValue } from 'pve-agent'

await using cluster = await pve.connect()
const vm = cluster.vm(100)

const config = await vm.config()
const net0 = config.nets['net0'] ?? {}
console.log(net0['model'], net0['macaddr'], net0['bridge'], net0['tag'])

const scsi0 = parseGuestConfigValue('qemu', 'scsi0', String(config.raw['scsi0']))
console.log(scsi0['file'], scsi0['size'], scsi0['discard'], scsi0['ssd'])

await vm.configure({
	net0: formatGuestConfigValue('qemu', 'net0', { ...net0, tag: 30 }),
})
```

`parseGuestConfigValue` and `formatGuestConfigValue` take the guest type and
the config key. An indexed key resolves to its family, so `net0` through
`net31` all find the `net[n]` format.

## From any endpoint

`parseConfigValue` and `formatConfigValue` take a concrete path and find the
format in the same registry the client uses, so no format has to be carried
around:

```ts
import { formatConfigValue, parseConfigValue, propertyFormatFor } from 'pve-agent'

const path = '/nodes/ms01-0160/qemu/100/config'
const scsi0 = parseConfigValue('PUT', path, 'scsi0', 'local-zfs:vm-100-disk-0,size=32G,discard=on,ssd=1')
// { file: 'local-zfs:vm-100-disk-0', size: '32G', discard: 'on', ssd: true }
console.log(scsi0)

const migration = formatConfigValue('PUT', '/cluster/options', 'migration', {
	type: 'secure',
	network: '10.10.12.0/24',
})
console.log(migration) // 'secure,network=10.10.12.0/24'

console.log(propertyFormatFor('PUT', path, 'net0')) // the format itself, or undefined
```

Both accept a concrete path and a concrete indexed key.

## What parsing does

Parsing resolves the default key, aliases and key aliases, and coerces values
to the types the format declares. In `net0`, `virtio=...` is the model rather
than a sub-key called `virtio`, so it comes back as `model` with the address
under `macaddr`.

```ts
import { parsePropertyString, propertyFormatFor } from 'pve-agent'

const netFormat = propertyFormatFor('PUT', '/nodes/{node}/qemu/{vmid}/config', 'net[n]')
console.log(parsePropertyString('virtio=BC:24:11:A1:B2:C3,bridge=vmbr0', netFormat))
// { model: 'virtio', macaddr: 'BC:24:11:A1:B2:C3', bridge: 'vmbr0' }
```

Two options:

```ts
import { parseConfigValue } from 'pve-agent'

parseConfigValue('PUT', '/nodes/ms01-0160/qemu/100/config', 'net0', 'virtio,bridge=vmbr0', {
	strictKeys: true, // default: reject a sub-key the format does not declare
	validate: false, // default: skip enum and required-sub-key checks
})
```

A value that does not fit its format throws `PvePropertyError`. The guest
config normalizers parse with `strictKeys: false`, so a newer node still
reads.

## What formatting does

Encoding orders the parts the way PVE does: the default key, then required
sub-keys, then the rest, each group sorted. A value whose sub-keys were
already in that order comes back byte for byte; the rest come back
semantically equal with the sub-keys re-sorted, which is worth knowing before
you diff a config against what you sent.

The default key is written bare, without its name, which is the form PVE
writes too. `formatConfigValue('PUT', '/cluster/options', 'migration',
{ type: 'secure', network: '10.10.12.0/24' })` gives
`secure,network=10.10.12.0/24`, and the node reads that and
`type=secure,network=10.10.12.0/24` as the same value. A boolean goes out as
`1` or `0`, and a number in a `disk-size` sub-key goes out with a K, M, G or
T suffix.

## Without a format

```ts
import { formatPropertyString, parsePropertyString, splitPropertyParts } from 'pve-agent'

console.log(splitPropertyParts('local-zfs:vm-100-disk-0,size=32G,ssd=1'))
// { bare: ['local-zfs:vm-100-disk-0'], entries: [['size', '32G'], ['ssd', '1']] }

console.log(parsePropertyString('a=1,b=2')) // { a: '1', b: '2' }
console.log(formatPropertyString({ a: '1' })) // 'a=1'
```

`splitPropertyParts` is the raw split: `bare` holds the parts with no `=`,
which is where the default key's value sits, and `entries` holds the rest in
order. Without a format, a bare part throws from `parsePropertyString`.

## Values

```ts
import { formatSize, parseBoolean, parseSize } from 'pve-agent'

console.log(parseBoolean('1')) // true
console.log(formatSize(34359738368)) // '32G'
console.log(parseSize('32G')) // 34359738368
```

PVE booleans arrive as `0`, `1`, `'0'`, `'1'` or a real boolean, depending on
the handler. `parseBoolean` reads `1`, `on`, `yes` and `true` against `0`,
`off`, `no` and `false`.

## Indexed keys

The schema writes an indexed family as `net[n]`; a config writes one member
as `net0`.

```ts
import {
	collapseIndexedKey,
	expandIndexedKey,
	indexedKeyBase,
	isIndexedKey,
	splitIndexedKey,
} from 'pve-agent'

console.log(isIndexedKey('net[n]')) // true
console.log(indexedKeyBase('net[n]')) // 'net'
console.log(expandIndexedKey('net[n]', 3)) // 'net3'
console.log(splitIndexedKey('mp12')) // { base: 'mp', index: 12 }
console.log(collapseIndexedKey('net0', ['net[n]'])) // 'net[n]'
```

`collapseIndexedKey` takes the set of schema keys to match against, so `net0`
only collapses when `net[n]` is one of them.

## Which parameters are property strings

The registry marks them:

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()

const endpoint = cluster.client.endpointFor('PUT', '/nodes/ms01-0160/qemu/100/config')
for (const [name, param] of Object.entries(endpoint?.params ?? {})) {
	if (param.propertyString) console.log(name, param.format)
}
```

A format read out of a typetext line, because the parameter uses a format
registered by name, names every sub-key and marks the default key but carries
no enums. Those are listed in `TYPETEXT_DERIVED_FORMATS`.

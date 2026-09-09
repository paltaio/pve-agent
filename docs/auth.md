# Authentication tiers

Three credentials reach three different sets of things. Configure as many as
you can; the client picks per call.

| Tier | Reaches | Set with |
| --- | --- | --- |
| API token | 520 of the 537 endpoints in the registry | `PVE_TOKEN_ID`, `PVE_TOKEN_SECRET` |
| `root@pam` ticket | The other seventeen, a set of root-only parameters, and a root shell over termproxy | `PVE_USER=root@pam`, `PVE_PASSWORD` |
| Root SSH | Everything with no endpoint at all | A key authorised for root on each node |

## Tier 1: the API token

A token reaches 520 of the 537 endpoints, including the four guest console
endpoints, `vncproxy`, `vncwebsocket`, `termproxy` and `spiceproxy`, so VNC
keyboard, mouse, screenshots and the serial console all work on a token alone.
Token calls skip CSRF.

A token has its own identity, `user@realm!name`. With `privsep` on, which is
the default, it holds only the privileges an ACL grants to the token id
itself, so a fresh token can do nothing until it is named in an ACL. With
`privsep` off it inherits the user's privileges.

```ts
import pve from 'pve-agent'
import { writeFile } from 'node:fs/promises'

await using cluster = await pve.connect()

const created = await cluster.access.createToken('automation@pve', 'ci', { privsep: false })
// The secret is readable this once; keep it in a file only the owner can read.
await writeFile('ci.env', `PVE_TOKEN_ID=${created.fullTokenId}\nPVE_TOKEN_SECRET=${created.value}\n`, {
	mode: 0o600,
})
await cluster.access.setAcl({
	path: '/vms',
	roles: 'PVEVMAdmin',
	tokens: 'automation@pve!ci',
	propagate: true,
})
```

`PVE_TOKEN_ID` takes either spelling. A bare `automation` is joined with
`PVE_USER` to make `automation@pve!ci`; without `PVE_USER` a bare name
throws `PveConfigError`.

Five endpoints are registered with `allowtoken 0` and refuse a token however
it is privileged:

```
POST   /access/ticket
PUT    /access/password
POST   /access/tfa/{userid}
PUT    /access/tfa/{userid}/{id}
DELETE /access/tfa/{userid}/{id}
```

The client switches to the ticket for these on its own. Any user's ticket
passes.

## Tier 2: a literal `root@pam` ticket

Twelve endpoints are registered with no permissions block at all. Their
handlers compare the caller against the string `root@pam`. A root-owned API
token identifies as `root@pam!name`, which is a different string, so it fails
the comparison however privileged it is. Only a login ticket for `root@pam`
passes.

```
POST   /cluster/config                     create a cluster
POST   /cluster/config/join                join one
POST   /cluster/config/nodes/{node}        add a node
DELETE /cluster/config/nodes/{node}        remove a node
POST   /nodes/{node}/execute               batch several API calls in one request
PUT    /nodes/{node}/disks/wipedisk        wipe a disk
GET    /cluster/backup-info                backup information
POST   /nodes/{node}/storage/{storage}/content/{volume}   copy a volume
POST   /cluster/acme/account               register an ACME account
GET    /cluster/acme/account/{name}        read one
PUT    /cluster/acme/account/{name}        update one
DELETE /cluster/acme/account/{name}        deactivate one
```

`ROOT_ONLY_ENDPOINTS` exports the same list.

The same comparison gates individual parameters on endpoints a token
otherwise reaches. Some of these say so in the schema; the rest are enforced
in handler code, and several depend on the value rather than the name:

| Parameter | Endpoints | Needs the ticket when |
| --- | --- | --- |
| `skiplock` | qemu and lxc | always |
| `lock` | qemu create and config | always |
| `hookscript` | qemu and lxc create and config | always |
| `args` | qemu create and config | always |
| `serial[n]` | qemu create and config | the value is not `socket`, so a real host device |
| `usb[n]` | qemu create and config | a raw `host=` rather than `mapping=`, unless the host is `spice` |
| `hostpci[n]` | qemu create and config | a raw `host=` rather than `mapping=`, or any `romfile=` |
| `migration_type`, `migration_network` | qemu | always |
| `force` | qemu migrate | always |
| `stateuri`, `targetstorage`, `force-cpu`, `with-conntrack-state`, `nets-host-mtu` | qemu start | always |
| `migratedfrom` | qemu start and stop | always |
| `keepActive` | qemu stop | always |
| `nocheck` | qemu resume | always |
| `dev[n]` | lxc create and config | always |
| `rootfs`, `mp[n]` | lxc create and config | the volume is a path, so a bind or device mount. A storage volume does not |
| `features` | lxc create and config | anything past `nesting` |
| `cmd` | node termproxy, vncshell, spiceshell | the value is not `login` |
| `job-id` | node vzdump | always |

A flag the handlers test with Perl truthiness passes when it is off, so
`skiplock: false` costs nothing. `ROOT_ONLY_PARAM_RULES` and
`DOCUMENTED_ROOT_ONLY_PARAMS` export the rules, and `rootOnlyParams(method,
templatePath, params)` answers for one call.

The `mapping=` forms are the way around `usb[n]` and `hostpci[n]`: define the
device once with `cluster.api.mapping.pci.create` and refer to it by name.
That needs no root ticket and survives migration.

## Tier 3: root SSH

Much of what an operator does on a Proxmox node has no endpoint at all:
installing a package, touching a systemd unit outside a 23-name list, every
ZFS operation other than pool create and destroy, clearing a container config
lock, importing a disk image from a node path. Those need a shell.

The shell layer prefers SSH: the command's own exit code, stdout and stderr
kept apart, and binary-safe transfer in both directions. See
[shell.md](shell.md).

The termproxy websocket on a node is the fallback for a caller that holds a
`root@pam` ticket and no SSH key; [shell.md](shell.md) has the details. The
per-guest `termproxy` is a different endpoint: it attaches to the guest's
serial console, and a token reaches it.

## How the client decides

Every call is matched against the generated registry before it goes out, and
the decision is available without sending anything:

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()

const decision = cluster.client.requiredTier('PUT', '/nodes/pve1/lxc/110/config', {
	mp0: '/srv/data,mp=/data',
})
console.log(decision.tier) // 'ticket'
console.log(decision.requiresRootPam) // true
console.log(decision.reason) // "parameter 'mp0' needs root@pam: bind and device mount points need root@pam; ..."
console.log(decision.rootOnlyParams) // [{ param: 'mp0', reason: '...' }]
```

The order is: a `rootOnly` endpoint, then a root-only parameter, then
`allowtoken 0`, then the token when one is configured, then the ticket.

When the credential the decision names is absent, the call throws
`PveTierError` before any request goes out, naming the environment variable to
set:

```ts
import pve, { PveTierError } from 'pve-agent'

await using cluster = await pve.connect()

try {
	await cluster.node('pve1').api.execute([{ path: 'version', method: 'GET' }])
} catch (error) {
	if (error instanceof PveTierError) {
		console.error(error.required) // 'ticket'
		console.error(error.available) // ['token']
		console.error(error.message) // names PVE_USER=root@pam and PVE_PASSWORD
	}
}
```

Watch the choice as it happens:

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect({
	onRequest: (trace) => {
		console.error(
			`${trace.decision.tier}${trace.escalated ? ' (escalated)' : ''} ` +
				`${trace.method} ${trace.path}: ${trace.decision.reason}`,
		)
	},
})
```

Override the choice for one call with `RequestOptions.tier`. A forced tier
skips the root@pam check, so a ticket for another user reaches the endpoint
and gets the node's own answer:

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()

await cluster.client.get('/version', undefined, { tier: 'ticket' })
```

## Tickets

A ticket lasts two hours and renews by sending the old ticket back as the
password, so a long-running script never re-sends the password. Ticket calls
attach `CSRFPreventionToken` on writes; token calls never do. A 401 on a
ticket call, which is what the API server answers for a ticket it no longer
verifies, triggers a fresh login and a single retry; a 403 is final.

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()

const auth = cluster.client.auth
console.log(auth.tiers) // ['token', 'ticket']
console.log(auth.hasRootTicket) // the ticket user is exactly root@pam
console.log(auth.ticketUsername) // 'root@pam'
const ticket = await auth.getTicket() // logs in or renews as needed
console.log(ticket.username, ticket.expiresAt)
```

The console layer puts `ticket.ticket` in the `PVEAuthCookie` cookie and
URL-encodes it, because the server runs the cookie value through
`uri_unescape`. A console opens on the ticket when the client holds one and
on the token otherwise; the proxy call and the WebSocket present the same
credential.

## Privileges by operation

The API privilege each guest operation needs, for building an ACL:

| Operation | Privilege |
| --- | --- |
| Read status, config, snapshots, pending | `VM.Audit` |
| Change config | `VM.Config.*`, split by area (`VM.Config.Disk`, `VM.Config.Network`, `VM.Config.Options`) |
| Start, stop, shutdown, reboot, suspend, resume | `VM.PowerMgmt` |
| Create, destroy | `VM.Allocate` on `/vms` |
| Allocate a disk | `Datastore.AllocateSpace` on the storage |
| Snapshot, delete a snapshot | `VM.Snapshot` |
| Roll back | `VM.Snapshot.Rollback` |
| Clone | `VM.Clone` |
| Migrate | `VM.Migrate` |
| Guest agent reads | `VM.GuestAgent.Audit` |
| Guest agent exec | `VM.GuestAgent.Unrestricted` |
| Guest agent file read and write | `VM.GuestAgent.FileRead`, `VM.GuestAgent.FileWrite` |
| Firewall reads and writes | `VM.Audit`, `VM.Config.Network` |

`cluster.access.permissions({ userid, path })` answers what a user or token
holds on a path after roles, groups and propagation are resolved.

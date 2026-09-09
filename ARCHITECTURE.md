# Architecture

The contracts a maintainer cannot read from one file header: how the modules
depend on each other, what every module agrees on, how a call picks its
credential, how wire values are read, what each error class means, how the
facade shares sessions, and where the tests live. Everything else is in the
header of the file that owns it.

## Layout

```
schema/          apidoc.json and pve-version.txt, dumped from a PVE node
scripts/         dump-schema.ts reads a node; generate-api.ts is the only writer of src/generated
src/generated/   endpoint registry, parameter interfaces, property formats
src/core/        credentials, HTTP, the client, property strings, wire values,
                 polling, tasks, errors
src/access/      users, groups, roles, ACLs, realms, tokens, TFA, tickets
src/cluster/     cluster-wide endpoints: status, HA, backup, firewall, pools,
                 storage definitions, membership, mappings, metrics,
                 notifications, jobs, bulk actions
src/node/        one node: network, storage, disks, apt, services, certificates,
                 hardware, scan, tasks, replication, vzdump
src/guest/       QEMU and LXC: discovery, lifecycle, config, snapshots, firewall,
                 the guest agent
src/guest-os/    running commands inside a guest, per OS
src/console/     VNC, the serial console, framebuffer reading, screenshots
src/shell/       root shells on a node, and the ZFS, systemd, apt, qm and pct
                 helpers on them
src/pve/         the facade: PveCluster, PveNode, PveVm, PveContainer
src/index.ts     the public entry point
docs/            the reference, organised by task
examples/        runnable scripts
test/live/       the suite that runs against a cluster
```

The dependency order is `src/generated`, then `src/core`, then the feature
modules, then `src/pve`. Nothing in `src/core` depends on a feature module.
The feature modules depend on `src/core` and on each other only downwards in
the list above (`guest-os` on `guest` and `shell`, `shell` on `console` for the
termproxy framing). `src/pve` composes the feature modules and is the only
place that holds session state.

`src/index.ts` exports `pve` with `connect` as the default, and every class,
function and type in the modules by name. Unit tests sit next to the module
they cover as `*.test.ts`.

`src/generated` is committed. `bun run schema root@<node>` rewrites `schema/`
from a node and `bun run generate` rewrites `src/generated` from it; the
output is never edited by hand. `src/generated/generated.test.ts` checks the
registry against `schema/apidoc.json`, so a schema refresh that changes the
endpoint set fails there with the difference. Ceph and SDN are left out of
the registry.

## Module conventions

- A removal is `delete`. `NodeNetworkApi.deleteInterface` keeps its noun
  because the class also deletes the staged file.
- The trailing bag of optional settings is `options`, and a list filter is a
  field on it rather than a positional scalar.
- A delete guarded by a digest takes it in that same object:
  `rules.delete(pos, { digest })`.
- A row type whose wire shape differs from its useful shape is normalized and
  carries `raw`; see Wire values.
- `ClusterApi` and `NodeApi` compose sub-objects. `AccessApi` is one flat
  class.
- A method on a module class that starts a worker task returns the UPID. The
  facade waits for it and returns the `TaskStatus`.
- `src/pve` reaches the module classes through `api` on each handle, so the
  two surfaces never duplicate a parameter list.
- A path handed to the client is concrete, below `/api2/json`, with the
  variables filled in: `/nodes/pve1/qemu/110/config`. The return value is the
  `data` field of the response.
- Every command line the shell layer sends is interpreted by a POSIX shell as
  root on the node. A value from outside goes through `shQuote`, `shJoin` or
  `shHeredoc` first; a bare number through `assertSafeInteger`; a name joined
  to a fixed directory through `assertPathSegment`. Each refuses with
  `PveShellPolicyError`; `shQuote` also refuses a value that is not a string.
- The shell policy checks each command as the shell would hand it over:
  quotes removed, wrappers such as `sudo`, `env` and `timeout` stepped over
  to the program they run, and a `sh -c` body parsed as lines of its own.
  `NodeShell.run` runs the same check over `input` when the command runs an
  interpreter.

## How a call picks its credential

Every call in the library goes through `PveClient.request`, so the registry
lookup, the tier decision, the `onRequest` trace, CSRF on ticket writes and
the retry happen once and apply to all of them.

An API token reaches every endpoint in the registry except seventeen. Five
are registered with `allowtoken 0` and take only a ticket, for any user:
`POST /access/ticket`, `PUT /access/password` and the three TFA writes.
Twelve are registered with no permissions block, and their handlers compare
the caller against the literal `root@pam`; a root-owned token is
`root@pam!name` and fails the comparison. `ROOT_ONLY_ENDPOINTS` and
`TOKEN_FORBIDDEN_ENDPOINTS` in `src/generated/endpoints.ts` list them.

The same comparison gates individual parameters on endpoints a token
otherwise reaches. `src/core/privileges.ts` holds those rules:
`rootOnlyParams(method, templatePath, params)` answers for one call, and some
rules read the value: `mp0` needs root only for a bind or device mount,
`hostpci0` only for a raw `host=` or a `romfile=`, `serial0` only for a value
other than `socket`, `features` only past `nesting`, `cmd` on the node shells
only for a value other than `login`. A flag the handlers test with Perl
truthiness passes when it is off. What the schema text marks as root-only is
collected by the generator into `DOCUMENTED_ROOT_ONLY_PARAMS` and fills in the
parameters no rule covers.

`requiredTier(method, path, params)` returns the decision without sending
anything. The order is a `rootOnly` endpoint, then a root-only parameter,
then `allowtoken 0`, then the token when one is configured, then the ticket.
When the credential the decision names is absent, the call throws
`PveTierError` before any request goes out. `RequestOptions.tier` overrides
the choice for one call and skips the root@pam check. A path the registry
does not hold throws `PveConfigError` unless the call passes
`allowUnknownEndpoint`.

Parameters go over as form fields: booleans as `1` and `0`, arrays as a
repeated key, `undefined` and `null` dropped. GET and DELETE put them in the
query string, because the API server refuses a DELETE that carries a body.
Ticket calls attach `CSRFPreventionToken` on writes; token calls never do. A
ticket in its last quarter hour is renewed before the call, and a 401 on a
ticket call triggers a fresh login and a single retry; a 403 is final.

A console opens on the ticket when the client holds one and on the token
otherwise, and the proxy call and the WebSocket present the same credential.
The console layer puts `ticket.ticket` in the `PVEAuthCookie` cookie,
URL-encoded, because the server runs the cookie value through `uri_unescape`.
The node shell prefers SSH and falls back to the termproxy websocket only for
a `root@pam` ticket; `docs/shell.md` says why. Anything with no endpoint at
all belongs to the shell layer.

## Wire values

The API is generated from Perl, so a flag arrives as 0 or 1, as `'0'` or
`'1'`, sometimes as a real boolean, and an unset one is absent. Tag lists
arrive as one delimited string. Every module reads those through the helpers
in `src/core/values.ts` (`toBoolean`, `toOptionalBoolean`, `toOptionalNumber`,
`toOptionalString`, `parseTagList`, `stringList`, `isRecord`), so a field
means the same thing wherever it appears. A numeric field is read as a plain
decimal numeral only.

A row type that carries such a field is normalized rather than handed over
raw: its flags are booleans, its tag string is an array, its hyphenated keys
are camelCase, and the untouched answer is under `raw`. That covers the guest
summaries, statuses, configs and snapshots, `/cluster/resources`,
`/cluster/status`, cluster storage, HA, backup, replication, notification,
metrics and firewall rows, node storage, network, disks, PCI and replication
rows, task rows, and everything under `/access`.

A type with no such field, such as `ClusterLogEntry`, is a passthrough and
keeps its index signature. So are the nested blobs a node builds for itself,
such as `NodeStatus`, `AptRepositories` and the firewall `getOptions` reads,
which stay records and keep the node's own 0 and 1 spelling.

Two more rules of the same kind. `status` means opposite things on the two
task endpoints PVE offers, so `TaskStatus` and `TaskListEntry` both come out
with `status` meaning the run state and `exitStatus` the exit status. A
property string (`key=value,key=value`) has no quoting and no escaping, so a
value containing a comma cannot be represented; the encoder refuses one, as
the node does, and lists inside a value use semicolons.

## Errors

`src/core/errors.ts`. Every class extends `PveError`, which carries a `kind`.
This table is the one home of the list; the docs link here.

| Class | kind | Raised when |
| --- | --- | --- |
| `PveConfigError` | `config` | a credential or a parameter value is missing or unusable, or the path is outside the generated registry |
| `PveConnectionError` | `connection` | DNS, TCP, TLS or a timeout; carries `url` without its query string, where a GET or DELETE puts its parameters |
| `PveAuthError` | `auth` | the API answered 401; carries the `tier` that failed, and its message quotes the response envelope |
| `PveTierError` | `tier` | the call needs a credential this client does not hold; `required`, `available` |
| `PvePermissionError` | `permission` | 403 with credentials that were accepted; `method`, `path`, `tier` |
| `PveNotFoundError` | `not-found` | 404, 501, or the 500 PVE sends when a guest or config file is missing; `method`, `path` |
| `PveApiError` | `api` | any other non-2xx, or a 2xx whose body is not JSON; `status`, `method`, `path`, per-parameter `errors` |
| `PveTaskError` | `task` | a worker task failed, or outlived a wait; `upid`, `exitStatus`, `timedOut`, `log` |
| `PveTimeoutError` | `timeout` | a condition a caller waited for did not hold before the deadline, with no task behind it; `what`, `waitedMs` |
| `PvePropertyError` | `property` | a property string does not fit its format |
| `PveConsoleError` | `console` | a console transport or protocol failure, or a refused login |
| `GuestCommandError` | `guest-command` | a command run inside a guest exited non-zero; `vmid`, `exitCode`, `stdout`, `stderr` |
| `GuestOutputTruncatedError` | `guest-command` | the guest agent cut a command's output at its 16 MiB cap, so a file read is incomplete; `vmid` |
| `PveShellError` | `shell` | the root-shell layer failed; `shell` says which way |

`src/shell/errors.ts` narrows the shell case. Every one carries `kind: 'shell'`
and a `shell` field naming the failure:

| Class | shell | Raised when |
| --- | --- | --- |
| `PveShellCredentialError` | `credential` | no SSH key and no root@pam ticket, so no transport can open a root shell; `node` |
| `PveShellTransportError` | `transport` | the transport did not connect, dropped mid-command, or a termproxy size limit was passed; `node`, `transport` |
| `PveShellPolicyError` | `policy` | the policy refused the command, or a value failed a quoting check; `command`, `reason` |
| `PveShellCommandError` | `command` | a command exited non-zero and the caller asked for the code to be checked; `exitCode`, `stdout`, `stderr` |
| `PveShellOutputError` | `output` | a command ran but printed something the helper cannot read, such as `qm guest exec` output that is not JSON; `output` |
| `PveShellTimeoutError` | `timeout` | a command produced no result before its deadline; `timeoutMs`, `partialOutput` |

Two rules keep the classes apart. `PveTaskError.upid` is always a real UPID,
so `client.taskLog(error.upid)` works on it; a wait with no task behind it
(`waitForRunState`, `waitForAgent`, `waitForScreen`, the serial waits, a guest
command past its deadline) throws `PveTimeoutError` instead. `WARNINGS: n` is
a success status unless the caller sets `failOnWarnings`.

One backoff policy in `src/core/poll.ts` serves every wait: the first probe
runs before any delay, then delays double from 200 ms to a 2 s ceiling until
a ten minute default deadline. `done` says when the answer is final and
`onTimeout` decides what a deadline means for that caller.

## The facade and its sessions

`connect()` builds one `PveCluster` from the credentials, checks them with
`GET /version`, and every node, guest and console handle hangs off it. A
handle is a value object holding a name and a vmid; making one sends nothing.
`node()`, `vm()` and `container()` default the node to `PVE_NODE` and throw
`PveConfigError` when neither is set.

The sessions a handle reaches for belong to the cluster and are keyed by vmid
or node name in a `SessionStore`, one per kind: node shells, VNC sessions,
serial consoles. The store's contract:

- one open per key is in flight at a time, so concurrent callers share a
  handshake;
- a failed open leaves no entry behind, so the next call tries again;
- a session that closes underneath forgets its own entry, and a node shell
  does the same when its transport fails to carry a command
  (`NodeShell.onClose`), so the next `node.shell` opens a fresh one;
- `close()` drains every store, closes every session, then releases the
  client, and is safe to call twice.

Two clusters in one process share nothing: separate clients, separate
websockets, separate node shells.

`PveContext` is what a handle needs from the cluster: the client and the
session methods. `PveNode`, `PveVm` and `PveContainer` hold a context, not a
`PveCluster`, so the facade tests build them over fakes.

Where the facade adds something, the accessor is an object with methods:
`vm.kvm` (`VmKvm`) and `guest.console` (`GuestConsole`) connect on the first
call and hand the session underneath back through `session()`. Where the
module object is already the right thing, the accessor is that object once its
transport is open, so it is awaited: `await node.shell`, `await ct.shell`,
`await vm.os`, `await ct.os`. A failed `os` open is retried on the next await.

`guest.api` is the module handle underneath a guest (`QemuApi` or `LxcApi`),
and its lifecycle calls return the raw UPID. The handle's power calls,
snapshot calls and `delete` wait for the task and post it again for up to 45 s
while it fails on the guest's config lock, which the node takes before it
changes anything.
`delete` closes the guest's console sessions first, since a destroyed guest's
sockets go away underneath them.

## Testing

`bun test` runs every `*.test.ts` under `src` and `test`. The unit tests need
no cluster:

- `src/core/test-support/api-mock.ts` starts a TLS server that records every
  request and answers from a queue of scripted replies. The client, the
  registry, the parameter encoding and the ticket login all run for real
  against it, so a test asserts the exact method, URL, headers and body a call
  produces. `POST /access/ticket` is answered by the server itself. The
  certificate is generated once per process with `openssl`, which has to be on
  PATH.
- `src/shell/test-support.ts` has a `FakeTransport` that answers from a table
  of replies and records every call, and a `FakePty` that plays the far side
  of a termproxy websocket.
- `src/console/test-support/frames.ts` builds framebuffer snapshots in the
  session's pixel format for the matcher and screenshot tests.
- `src/pve/test-support.ts` has a `FakeVncServer` that completes the RFB
  handshake on its own, a socket factory that hands out VNC servers and
  terminal ptys by URL, and an `ssh` binary answered from a table.

`test/live/` runs against a cluster when `PVE_LIVE=1` is set and reports every
test as skipped otherwise. `test/live/support.ts` names the nodes, storages,
bridge, pool and guests the suite expects, each as a `PVE_LIVE_*` variable
with a default, probes the cluster once at load and skips a test whose
fixture is absent. It opens one connection per file and removes the scratch
guests before and after a run, refusing to touch a guest whose name is
outside the scratch prefix. `PVE_LIVE_ALL=1` adds the Windows and macOS guest
groups, which are stopped again only when the run started them.

Test support files and `*.test.ts` stay out of the published package;
`package.json` `files` lists the exclusions.

```
bun install
bun test              # every test file; the live tests are skipped without PVE_LIVE
bun run typecheck     # tsc --noEmit over src, scripts, test and examples
bun run format        # oxfmt; markdown, schema/ and src/generated are ignored
```

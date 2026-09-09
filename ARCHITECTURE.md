# Architecture

A TypeScript library for driving a Proxmox VE cluster from Bun.

## Layout

```
schema/          apidoc.json and pve-version.txt, dumped from a PVE 9.2.11 node
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
`src/pve` composes the feature modules and is the only place that holds session
state.

`src/index.ts` exports `pve` with `connect` as the default, and every class,
function and type in the modules by name. Unit tests sit next to the module
they cover as `*.test.ts`.

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

## Running things

```
bun install
bun test              # every test file; the live tests are skipped without PVE_LIVE
bun run typecheck     # tsc --noEmit over src, scripts and test
bun run format        # oxfmt; markdown, schema/ and src/generated are ignored
bun run schema root@<node>   # rewrites schema/ from a node
bun run generate      # rewrites src/generated from schema/apidoc.json
```

`src/generated` is committed. Run `bun run generate` after a schema refresh
and never edit the output.

## Credentials

`src/core/auth.ts`

```ts
loadCredentials(input?: CredentialInput): PveCredentials
```

Resolution order: explicit input, then process env, then a shell-style env file
(`input.envFile`, then `PVE_ENV_FILE`, then `./pve.env`). A line may start with
`export ` and a value may be quoted. The variables are `PVE_HOST`, `PVE_PORT`,
`PVE_USER`, `PVE_PASSWORD`, `PVE_TOKEN_ID`, `PVE_TOKEN_SECRET`,
`PVE_VERIFY_SSL` and `PVE_NODE`. A `PVE_TOKEN_ID` without a `!` is joined to
`PVE_USER`.

```ts
class PveAuth {
	constructor(credentials: PveCredentials, http: HttpClient)
	readonly connection: PveConnection
	get baseUrl(): string                      // https://host:port
	get verifySsl(): boolean
	get tiers(): readonly AuthTier[]           // 'token' before 'ticket'
	get ticketUsername(): string | undefined
	get hasRootTicket(): boolean               // the ticket user is root@pam
	has(tier: AuthTier): boolean
	tokenHeader(): string                      // Authorization header value
	getTicket(): Promise<PveTicket>            // logs in, or renews in the last quarter hour
	authenticate(): Promise<PveTicket>         // logs in at once; concurrent callers share one call
	forceRefresh(): Promise<PveTicket>         // discards the cached ticket and logs in again
	destroy(): void
}
```

A `PveTicket` is `{ ticket, csrfToken, username, expiresAt }`. Tickets last
two hours and renew by sending the old ticket as the password. The console
layer puts `ticket.ticket` in the `PVEAuthCookie` cookie, URL-encoded, because
the server runs the cookie value through `uri_unescape`.

## Token and ticket

An API token reaches every endpoint in the registry except seventeen. Five
are registered with `allowtoken 0` and take only a ticket, for any user:
`POST /access/ticket`, `PUT /access/password` and the three TFA writes. Twelve
are registered with no permissions block, and their handlers compare the
caller against the literal `root@pam`; a root-owned token is `root@pam!name`
and fails the comparison. `ROOT_ONLY_ENDPOINTS` and
`TOKEN_FORBIDDEN_ENDPOINTS` in `src/generated/endpoints.ts` list them.

`src/core/privileges.ts` holds the parameter side:

```ts
rootOnlyParams(method: string, path: string, params?: object): RootOnlyParamHit[]
ROOT_ONLY_PARAM_RULES: readonly RootOnlyParamRule[]
```

`path` is the registry template, such as `/nodes/{node}/lxc/{vmid}/config`.
Some rules read the value: `mp0` needs root only for a bind or device mount,
`hostpci0` only for a raw `host=` or a `romfile=`, `serial0` only for a value
other than `socket`, `features` only past `nesting`, `cmd` on the node shells
only for a value other than `login`. A parameter the handlers test with Perl
truthiness passes when it is off. Anything the schema text marks as root-only
is collected by the generator into `DOCUMENTED_ROOT_ONLY_PARAMS` and fills in
the parameters no rule covers.

Anything with no endpoint at all belongs to the shell layer.

## The client

`src/core/client.ts`

```ts
class PveClient {
	constructor(options: PveClientOptions)
	static fromEnv(input?: CredentialInput & {
		timeoutMs?: number
		onRequest?: (trace: RequestTrace) => void
	}): PveClient

	readonly auth: PveAuth
	readonly http: HttpClient
	get baseUrl(): string
	get defaultNode(): string | undefined

	request<T>(method: HttpMethod, path: string, params?: PveParams, options?: RequestOptions): Promise<T>
	request<T>(method, path, params, options: RequestOptions & { withAttribs: true }): Promise<EnvelopeResult<T>>
	get<T>(path: string, params?: PveParams, options?: RequestOptions): Promise<T>
	post<T>(path: string, params?: PveParams, options?: RequestOptions): Promise<T>
	put<T>(path: string, params?: PveParams, options?: RequestOptions): Promise<T>
	delete<T>(path: string, params?: PveParams, options?: RequestOptions): Promise<T>

	signRequest(method: HttpMethod, path: string, params?: PveParams, options?: RequestOptions): Promise<SignedRequest>

	endpointFor(method: HttpMethod, path: string): EndpointInfo | undefined
	requiredTier(method: HttpMethod, path: string, params?: PveParams): TierDecision

	taskStatus(upid: string): Promise<TaskStatus>
	waitForTask(upid: string, options?: WaitOptions): Promise<TaskStatus>
	taskLog(upid: string, options?: TaskLogOptions): Promise<string[]>

	close(): void
}
```

Every call in the library goes through `request`, so the registry lookup, the
tier decision, the root@pam check, the `onRequest` trace, CSRF on ticket writes
and the single 403 retry happen once and apply to all of them.
`RequestOptions.body` takes an `HttpBody` for a multipart upload, and
`withAttribs` returns `{ data, attribs }` for the reads that set a key beside
`data`. `signRequest` returns the URL and headers without sending, for an
endpoint whose answer is not JSON.

`path` is concrete, below `/api2/json`, with the variables filled in:
`/nodes/ms01-0160/qemu/110/config`. The return value is the `data` field of the
response. `PveParams` is `object`, so a generated parameter interface passes
without an index signature; the values are checked when they are encoded.

Each call is matched against the generated registry, which gives the client
the path template, the parameter metadata and the privilege flags. A path that
is not in the registry throws `PveNotFoundError` unless the call passes
`{ allowUnknownEndpoint: true }`.

`requiredTier` returns the decision without sending anything:

```ts
interface TierDecision {
	tier: AuthTier
	reason: string
	requiresRootPam: boolean
	endpoint: EndpointInfo | undefined
	rootOnlyParams: readonly RootOnlyParamHit[]
}
```

The order is a `rootOnly` endpoint, then a root-only parameter, then
`allowtoken 0`, then the token when one is configured, then the ticket.
Escalation is visible through `onRequest`, which fires before every attempt:

```ts
interface RequestTrace {
	method: HttpMethod
	path: string
	endpointPath: string | undefined
	decision: TierDecision
	escalated: boolean
	attempt: number
}
```

When the needed credential is absent, the call throws `PveTierError` naming the
environment variable to set, before any request goes out. `RequestOptions.tier`
overrides the choice for one call, and skips the root@pam check.

Parameters go over as form fields: booleans as `1` and `0`, arrays as a
repeated key, `undefined` and `null` dropped. GET and DELETE put them in the
query string, because the API server refuses a DELETE that carries a body.
Ticket calls attach `CSRFPreventionToken` on writes; token calls never do. One
403 on a ticket call triggers a fresh login and a single retry.

A 2xx whose body is not JSON throws `PveApiError`, which catches a proxy
answering with its own error page. A 401 is `PveAuthError`, a 403 is
`PvePermissionError`, a 404, a 501 or a 500 whose message says the object does
not exist is `PveNotFoundError`, and anything else is `PveApiError` with the
per-parameter `errors` PVE sends.

`encodeParams`, `resolveEndpoint` and `unwrapEnvelope` are exported for use
outside a client instance.

## Property strings

`src/core/props.ts`

Many parameters are `key=value,key=value` text. The encoding has no quoting
and no escaping, so a value containing a comma cannot be represented; the
encoder refuses one, as the node does. Lists inside a value use semicolons.

```ts
parsePropertyString(input: string, format?: PropertyFormat, options?: ParseOptions): PropertyBag
formatPropertyString(bag: PropertyBag, format?: PropertyFormat, options?: FormatOptions): string
splitPropertyParts(input: string): { bare: string[]; entries: [string, string][] }

formatSize(bytes: number): string           // 34359738368 -> '32G'
parseSize(value: string): number | undefined

isIndexedKey(schemaKey: string): boolean    // 'net[n]' -> true
indexedKeyBase(schemaKey: string): string | undefined
expandIndexedKey(schemaKey: string, index: number): string   // 'net[n]', 3 -> 'net3'
collapseIndexedKey(configKey: string, known: Iterable<string>): string | undefined
splitIndexedKey(configKey: string): { base: string; index: number } | undefined
```

Parsing resolves the default key, aliases and key aliases, and coerces values
to the types the format declares. `net0: 'virtio=BC:24:11:A1:B2:C3,bridge=vmbr0'`
becomes `{ model: 'virtio', macaddr: 'BC:24:11:A1:B2:C3', bridge: 'vmbr0' }`
and encodes back to the same text. Encoding orders the parts the way PVE does:
the default key, then required sub-keys, then the rest, each group sorted.
Values whose sub-keys were already in that order come back byte for byte; the
rest come back semantically equal with the sub-keys re-sorted.

`strictKeys` defaults to true and rejects sub-keys the format does not declare.
`validate` defaults to false and turns on enum and required-sub-key checks. The
guest config normalizers parse with `strictKeys: false`, so a newer node still
reads.

`src/core/schema.ts` pairs the formats with the registry:

```ts
resolveEndpoint(method: string, path: string): EndpointInfo | undefined
propertyFormatFor(method: string, path: string, param: string): PropertyFormat | undefined
parseConfigValue(method, path, param, value, options?): PropertyBag
formatConfigValue(method, path, param, bag, options?): string
```

All accept a concrete path and a concrete indexed key, so
`('PUT', '/nodes/ms01/qemu/110/config', 'net0')` finds the `net[n]` format.
`resolveEndpoint` matches a concrete path against the templates with the same
method and segment count; when several fit, the one with the most literal
segments wins.

## Wire values

`src/core/values.ts`

The API is generated from Perl, so a flag arrives as 0 or 1, as `'0'` or
`'1'`, sometimes as a real boolean, and an unset one is absent. Tag lists
arrive as one delimited string. Every module reads those through the same
helpers, so a field means the same thing wherever it appears.

```ts
parseBoolean(value: string): boolean | undefined      // 1, on, yes, true; 0, off, no, false
toBoolean(value: unknown): boolean                    // absent or unreadable is false
toOptionalBoolean(value: unknown): boolean | undefined
toOptionalNumber(value: unknown): number | undefined
toOptionalString(value: unknown): string | undefined
parseTagList(value: unknown): string[]
```

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

## Polling

`src/core/poll.ts`

```ts
sleep(ms: number, signal?: AbortSignal): Promise<void>
pollUntil<T>(probe: () => Promise<T>, options: PollOptions<T>): Promise<T>
```

One backoff policy serves every wait: the first probe runs before any delay,
then delays double from 200 ms to a 2 s ceiling until a ten minute default
deadline. `done` says when the answer is final and `onTimeout` decides what a
deadline means for that caller: `waitForTask`, `waitForRunState`,
`waitForAgent` and `waitForScreen` throw from it, while `QemuAgent.exec`
returns the last answer with `timedOut: true`. `waitForScreen` sets both delays
to its `intervalMs`, so it reads the screen at a fixed rate.

## Tasks

`src/core/tasks.ts`

```ts
isUpid(value: unknown): value is string
parseUpid(upid: string): ParsedUpid           // node, pid, pstart, startTime, type, id, user
taskOutcome(exitStatus: string | null): 'ok' | 'warning' | 'error' | 'unknown'
normalizeTaskListEntry(raw: object): TaskListEntry

getTaskStatus(client: PveClient, upid: string, options?: RequestOptions): Promise<TaskStatus>
getTaskLog(client: PveClient, upid: string, options?: TaskLogOptions): Promise<string[]>
stopTask(client: PveClient, upid: string): Promise<void>
waitForTask(client: PveClient, upid: string, options?: WaitOptions): Promise<TaskStatus>
```

The UPID names the node that runs the task, so none of these take a node, and
`NodeTasksApi.status`, `log` and `stop` go to that node whichever node the
object is bound to.

`status` means opposite things on the two endpoints PVE offers.
`/nodes/{node}/tasks/{upid}/status` puts the run state in `status` and the exit
status in `exitstatus`; the list endpoints have no run state and put the exit
status in `status`, leaving it out while the task runs. `TaskStatus` and
`TaskListEntry` both come out with `status` meaning a run state and
`exitStatus` meaning an exit status, so `taskOutcome` reads the same field on
either.

`waitForTask` treats `WARNINGS: n` as success unless `failOnWarnings` is set. A
failure throws `PveTaskError` carrying `exitStatus` and the last 25 lines of
the task log; a run that outlives the timeout throws one with `timedOut: true`
and no exit status. `PveTaskError.upid` is always a real UPID, so
`client.taskLog(err.upid)` works on it. A wait with no task behind it, such as
`waitForRunState`, throws `PveTimeoutError`.

The log endpoint caps a request at 50 lines when no limit is given, so
`getTaskLog` sends `limit: 0` and reads the whole log unless the caller sets
one. `PveLogLine` is the `{ n, t }` shape every log endpoint answers with:
task, syslog, firewall and replication.

## Errors

`src/core/errors.ts`. Every class extends `PveError`, which carries a `kind`.

| Class | kind | Raised when |
| --- | --- | --- |
| `PveConfigError` | `config` | a credential or a parameter value is missing or unusable |
| `PveConnectionError` | `connection` | DNS, TCP, TLS or a timeout; carries `url` |
| `PveAuthError` | `auth` | the API rejected the credentials; carries the `tier` that failed |
| `PveTierError` | `tier` | the call needs a credential this client does not hold; `required`, `available` |
| `PvePermissionError` | `permission` | 403 with credentials that were accepted; `method`, `path`, `tier` |
| `PveNotFoundError` | `not-found` | 404, 501, a path outside the registry, or the 500 PVE sends when a guest or config file is missing |
| `PveApiError` | `api` | any other non-2xx, with per-parameter `errors` when PVE sends them; `status` |
| `PveTaskError` | `task` | a worker task failed, or outlived a wait; `upid`, `exitStatus`, `timedOut`, `log` |
| `PveTimeoutError` | `timeout` | a condition a caller waited for did not hold before the deadline, with no task behind it; `what`, `waitedMs` |
| `PvePropertyError` | `property` | a property string does not fit its format |
| `PveConsoleError` | `console` | a console transport or protocol failure, or a refused login |
| `GuestCommandError` | `guest-command` | a command run inside a guest exited non-zero; `vmid`, `exitCode`, `stdout`, `stderr` |
| `PveShellError` | `shell` | the root-shell layer failed; `shell` says which way |

`src/shell/errors.ts` narrows the shell case. Every one carries `kind: 'shell'`
and a `shell` field naming the failure:

| Class | shell | Raised when |
| --- | --- | --- |
| `PveShellCredentialError` | `credential` | no SSH key and no root@pam ticket, so no transport can open a root shell; `node` |
| `PveShellTransportError` | `transport` | the transport did not connect, or dropped mid-command; `node`, `transport` |
| `PveShellPolicyError` | `policy` | the policy refused the command, or a value failed a quoting check; `command`, `reason` |
| `PveShellCommandError` | `command` | a command exited non-zero and the caller asked for the code to be checked; `exitCode`, `stdout`, `stderr` |
| `PveShellTimeoutError` | `timeout` | a command produced no result before its deadline; `timeoutMs`, `partialOutput` |

## HTTP

`src/core/http.ts`

```ts
class HttpClient {
	constructor(options?: { verifySsl?: boolean; timeoutMs?: number })
	readonly verifySsl: boolean
	readonly timeoutMs: number                 // 60000 by default
	request(url: string, options?: HttpRequestOptions): Promise<HttpResponse>
	close(): void
}

type HttpBody =
	| string | ArrayBuffer | ArrayBufferView
	| Blob | FormData | URLSearchParams | ReadableStream<Uint8Array>
```

`request` wraps Bun's `fetch`. The TLS setting travels with each request as the
`tls.rejectUnauthorized` option, so nothing touches process-wide TLS state and
clients with different settings coexist. The body is read inside `request`, so
a reset during the read surfaces as `PveConnectionError` too; a caller's own
abort is rethrown as its reason. A Content-Type passed alongside a `FormData`
body is dropped, because the runtime writes the multipart boundary with it.
`close()` is a no-op: Bun's `fetch` pools sockets process-wide.

## Generated code

`src/generated/endpoints.ts`

```ts
const endpoints: Readonly<Record<EndpointKey, EndpointInfo>>
type EndpointKey                                  // 'PUT /nodes/{node}/qemu/{vmid}/config'
ROOT_ONLY_ENDPOINTS: readonly EndpointKey[]       // twelve
TOKEN_FORBIDDEN_ENDPOINTS: readonly EndpointKey[] // five
DOCUMENTED_ROOT_ONLY_PARAMS: Readonly<Record<string, readonly string[]>>

interface EndpointInfo {
	method, path, name, description
	allowToken: boolean          // false for the endpoints a token may never call
	rootOnly: boolean            // the handler tests for root@pam
	protectedCall: boolean       // runs in a privileged worker on the node
	proxyTo: string | null
	returnType: string
	discriminator?: { property, values }
	params: Readonly<Record<string, EndpointParam>>
}
```

The registry holds 537 endpoints. Ceph and SDN are left out.
`src/generated/generated.test.ts` checks the registry against
`schema/apidoc.json`, so a schema refresh that changes the endpoint set fails
there with the difference.

`src/generated/types.ts` has one parameter interface per endpoint. Path
variables are not fields, since they go in the path. An enum is a union of its
values: string literals, or numbers when the parameter's own type is `integer`
or `number`. An indexed family is a template-literal index signature, so
`net0` through `net31` all fit one declaration:

```ts
[key: `net${number}`]: string | undefined
```

Short names for the sets other modules build on:

```ts
QemuCreateParams        // POST /nodes/{node}/qemu
QemuConfigParams        // PUT  /nodes/{node}/qemu/{vmid}/config
QemuConfigAsyncParams   // POST /nodes/{node}/qemu/{vmid}/config
LxcCreateParams         // POST /nodes/{node}/lxc
LxcConfigParams         // PUT  /nodes/{node}/lxc/{vmid}/config
NetworkCreateParams, NetworkUpdateParams
StorageCreateParams, StorageUpdateParams
ZfsCreateParams
VzdumpParams
BackupJobCreateParams, BackupJobUpdateParams
HaResourceCreateParams, HaResourceUpdateParams
HaRuleCreateParams, HaRuleUpdateParams
ReplicationJobCreateParams, ReplicationJobUpdateParams
```

A few endpoints declare their parameters through `allOf` and a `oneOf` keyed on
a discriminator. Those become one interface per branch plus a union, and the
endpoint's own name is the union: `HaRuleCreateParams` narrows to
`ClusterHaRulesPostNodeAffinityParams` on `type: 'node-affinity'`. The registry
entry carries `discriminator: { property, values }` and a flattened `params`
bag, in which a property required in only one branch is optional.

`src/generated/formats.ts` has `propertyFormats`, keyed by
`"METHOD path paramName"`, and `TYPETEXT_DERIVED_FORMATS`. Entries listed in
the second one were read out of a typetext line because the parameter uses a
format registered by name; they name every sub-key and mark the default key,
and they carry no enums.

## PVE behaviour that catches callers out

- `POST /nodes/{node}/qemu/{vmid}/config` is asynchronous and returns a UPID.
  `PUT` on the same path takes the same parameters, is synchronous, and
  returns null. Use PUT unless the change hotplugs or allocates storage. LXC
  has only the PUT.
- LXC `unprivileged` documents `default: 0`, and the create handler uses 1 when
  the parameter is absent. `createContainer` sends `unprivileged: true` when
  the spec leaves it out and is not a restore.
- `/cluster/resources` maps every vmid in the cluster to its node in one call,
  from the cache pvestatd refreshes every few seconds.
- An endpoint with `proxyTo: 'node'` is forwarded by whichever node you ask, so
  a call reaches a guest on any node in the cluster. A node that is not a
  member yet needs its own client, built with `PveClient.fromEnv({ host })`.
- `/cluster/nextid` is registered as an integer and the handler sends a JSON
  string. `nextVmid` reads either and returns a number.
- A DELETE that carries a body is refused with "Unexpected content for method
  'DELETE'", so DELETE parameters go in the query string. Anything sensitive
  sent that way lands in the pveproxy access log; `AccessApi.deleteTfa` is the
  one call where that matters.
- The guest agent answers stdout, stderr and file content as one code point per
  byte. `QemuAgent` reads them back as bytes, which recovers UTF-8.
- `POST /nodes/{node}/termproxy` hands anyone who is not `root@pam` a
  `/bin/login` password prompt, an API token included.
- The `pct` and `qm` config endpoints store a description with a trailing
  newline, so a snapshot description read back is `text + '\n'`.

## Consoles

`src/console/`

`proxy.ts` makes the two calls that open a console. `requestVncProxy` posts to
`vncproxy` with `websocket: 1` and, for QEMU, `generate-password: 1`;
`requestTermProxy` posts to `termproxy` with the serial port for a VM. Both
answer with a port and a ticket good for about forty seconds. The proxy call
and the WebSocket present the same credential, chosen by `consoleTier`: the
login ticket when the client holds one, the API token otherwise.
`consoleWebSocketUrl` builds the `vncwebsocket` URL. `socket.ts` opens the
WebSocket on the `binary` subprotocol behind a `ConsoleSocket` interface, and a
`SocketFactory` replaces it in tests.

### VNC

`vnc.ts` holds `VncSession`, an RFB 3.8 client:

```ts
class VncSession extends EventEmitter<VncSessionEvents> {
	constructor(options: VncSessionOptions)        // client, node, vmid, type?, handshakeTimeoutMs?, maxMessageBytes?, socketFactory?
	connect(): Promise<VncScreenSize>              // proxy call, socket, handshake
	attach(socket: ConsoleSocket, password?: string): Promise<VncScreenSize>
	close(): void
	get connected(): boolean
	get screen(): Framebuffer | undefined
	get updateSeq(): number
	get heldKeys(): readonly number[]
	snapshot(): FramebufferSnapshot                // owned copy: { width, height, buffer, seq }
	press(combo: string): void                     // 'ctrl-alt-delete': down in order, up in reverse
	type(text: string, options?: TypeOptions): Promise<void>
	keyDown(key: string): void
	keyUp(key: string): void
	sendKeyEvent(down: boolean, keysym: number): void
	move(x: number, y: number): void
	click(x: number, y: number, button?: MouseButton): void
	scroll(x: number, y: number, direction: 'up' | 'down', amount?: number): void
	sendPointerEvent(buttonMask: number, x: number, y: number): void
	sendClipboard(text: string): void
	requestUpdate(): number                        // full repaint request; returns the paint counter
	waitForUpdate(timeoutMs?: number, since?: number): Promise<number>
}
```

The handshake negotiates security type 2 with the one-time password from
`vncproxy`, answered through `des.ts`, or type 1 when the server offers none.
`rfb.ts` holds the wire format: builders for the client messages, parsers that
return a value plus its length or the byte count still needed, and the keysym
tables. The session asks for a 32-bit little-endian pixel format with R at
shift 16, G at 8 and B at 0, and the Raw, CopyRect and DesktopSize encodings.
Every rectangle painted bumps the framebuffer's `updateSeq` and emits `update`
once the whole FramebufferUpdate has landed; a DesktopSize rectangle
reallocates the surface and emits `resize`. A message larger than
`maxMessageBytes` or a screen past 7680x4320 fails the session.

`keyDown` records the keysym, and a process exit hook releases every key a
session still holds. `type` sends one character at `cps` per second, wrapping
the characters a US keyboard reaches with shift in a shift press; newline and
tab go out as enter and tab. A pointer event outside the framebuffer throws
`PveConfigError`.

`framebuffer.ts` reads pixels out of a snapshot: `pixelAt`, `colorRatio`,
`changedFraction`, `cropFrame`, `scaleFrame`, `packRgb`. `screenshot.ts`
encodes a snapshot as JPEG through jpeg-js or as PNG written here, and
`captureScreenshot` with `fresh` requests a repaint and encodes the frame that
answers it. `match.ts` decides whether a screen shows what a caller is waiting
for:

```ts
type ScreenMatcher =
	| { kind: 'pixel'; x; y; color; threshold? }             // one pixel near a colour
	| { kind: 'color'; color; threshold?; area?; region? }   // a fraction of a region near a colour
	| { kind: 'changed'; since: FramebufferSnapshot; area?; region? }

matchScreen(frame, matchers, options?): ScreenMatchResult   // { matched, results }
waitForScreen(session, check, options?): Promise<FramebufferSnapshot>
```

`threshold` is a similarity from 0 to 1, where 0.9 lets each channel drift
about 25 levels. `waitForScreen` takes a predicate on the frame or matchers,
reads the screen every `intervalMs`, and throws `PveTimeoutError` at the
deadline.

### Serial

`terminal.ts` holds `SerialConsole`, the guest's serial port over the terminal
proxy, read back through a headless xterm:

```ts
class SerialConsole extends EventEmitter<SerialConsoleEvents> {
	constructor(options: SerialConsoleOptions)     // client, node, vmid, type?, serial?, cols?, rows?, scrollback?, connectTimeoutMs?, keepaliveMs?, socketFactory?
	connect(): Promise<void>
	attach(socket: ConsoleSocket, user: string, ticket: string): Promise<void>
	close(): void
	get connected(): boolean
	write(text: string): void
	sendLine(text: string): void
	sendKey(key: SerialKey): void
	resize(cols: number, rows: number): void
	screen(): string                               // the rendered screen, trailing blank lines removed
	readNew(): string                              // text rendered since the previous call
	waitForText(pattern: string | RegExp, options?: SerialWaitOptions): Promise<string>
	waitForPrompt(options?: PromptOptions): Promise<string>
	login(user: string, password: string, options?: PromptOptions): Promise<string>
}
```

`pty.ts` describes the framing of a termproxy websocket. The client sends
`user:ticket\n` first and the proxy answers `OK`. From then on every client
frame starts with a type digit: `0:<bytes>:<data>` carries input, split into
256-byte chunks, `1:<cols>:<rows>:` a window size, and `2` a keepalive, sent
every `keepaliveMs`. What the proxy sends is pty output with no framing at all.

Output goes into the emulator, so `screen()` is the text a user would see: a
redraw or a progress bar comes out as its final state, and colour and cursor
movement leave no escape sequences behind. `waitForPrompt` tests the line the
cursor is on against `SHELL_PROMPT`, a line ending in `$` or `#`. `login`
sends Enter when the cursor is not on a login prompt, waits for the login and
password prompts in turn, and throws `PveConsoleError` when the text after the
password matches a refusal. A wait that passes its deadline throws
`PveTimeoutError` with the last screen in its message.

## Shell

`src/shell/`

`types.ts` is the seam both transports sit behind:

```ts
interface ShellTransport {
	readonly kind: 'ssh' | 'termproxy'
	readonly node: string
	readonly description: string
	run(command: string, options?: RunOptions): Promise<CommandResult>   // { stdout, stderr, exitCode, durationMs }
	upload(localPath: string, remotePath: string): Promise<void>
	download(remotePath: string, localPath: string): Promise<void>
	close(): Promise<void>
}

interface RunOptions { timeoutMs?, input?, check?, env?, cwd? }
```

Every command line is interpreted by a POSIX shell running as root on the
node. `escape.ts` has what a value from outside goes through before it lands
in one: `shQuote`, `shJoin`, `shHeredoc`, `shWrap` for the `cd` and exports a
`RunOptions` asks for, `assertSafeInteger` for a value that goes in as a bare
number, and `assertPathSegment` for a name joined to a fixed directory. Each
refuses with `PveShellPolicyError`.

`ssh.ts` runs the system `ssh` binary with `BatchMode=yes`, keeps the command's
own exit code, stdout and stderr, moves files with `scp`, and multiplexes over
`controlPath` when one is set. Exit 255 with ssh's own diagnostic on stderr is
`PveShellTransportError`; a deadline is `PveShellTimeoutError`. `spawn.ts` is
the process runner behind it, and a `SpawnFn` replaces it in tests. `probeSsh`
runs `true` on the node.

`termproxy.ts` opens `POST /nodes/{node}/termproxy` on the ticket tier and
speaks the `pty.ts` framing over `vncwebsocket`. It throws
`PveShellCredentialError` before any request when the client holds no
`root@pam` ticket, and again when the far side answers with a login prompt.
After login it disables echo, clears the prompt, exports `TERM=dumb` and the
no-colour variables, and wraps each command so stdout, stderr and the exit code
come back between random markers the parser matches; stderr goes through a
temporary file on the node. The command travels base64-encoded and runs in a
subshell. A wrapped line over `maxCommandBytes` (4096), a transfer over
`maxTransferBytes` (1 MiB) or output over `maxOutputBytes` (8 MiB) throws
`PveShellTransportError`. Commands are serialized on one session.

`node-shell.ts` is the object a caller holds:

```ts
class NodeShell {
	static open(options: NodeShellOptions): Promise<NodeShell>   // node, transport?, ssh?, client?, termproxy?, policy?
	readonly node: string
	readonly transport: ShellTransport
	readonly policy: CommandPolicy
	readonly zfs: ZfsShell
	readonly systemd: SystemdShell
	readonly apt: AptShell
	readonly qm: QmShell
	readonly pct: PctShell
	get kind(): ShellTransportKind
	run(command: string, options?: RunOptions): Promise<CommandResult>
	output(command: string, options?: RunOptions): Promise<string>   // trimmed stdout; check: true
	upload(localPath: string, remotePath: string): Promise<void>
	download(remotePath: string, localPath: string): Promise<void>
	close(): Promise<void>
}

selectTransport(options: NodeShellOptions): Promise<ShellTransport>
```

`selectTransport` with `'auto'` probes SSH first and falls back to termproxy
when the client holds a `root@pam` ticket. With neither credential it throws
`PveShellCredentialError` naming both ways to fix it.

`policy.ts` runs on every `run` before the command goes to the node. A
`ShellPolicy` is `{ allow?, deny?, destructive? }`. A string pattern names a
program and matches when any command in the line runs it, by base name; a
RegExp is tested against the whole line. `deny` is checked first, then
`DESTRUCTIVE_PATTERNS` unless `destructive: 'allow'`, then `allow` when it is
set, which also refuses a line holding a command or process substitution.
`CommandPolicy.explain` answers the decision without running anything.
`DESTRUCTIVE_PATTERNS` covers `rm -r` and `rm -f`, `shred`, `find -delete`,
`zpool destroy`, `labelclear`, `split`, `remove`, `detach`, `offline` and
`replace`, `zfs destroy`, `rollback` and `change-key`, `mkfs`, partition table
tools, `dd of=`, LVM removal, LUKS format and key changes, `mdadm` array
changes, `qm destroy` and `pct destroy`, `pvecm delnode`, `apt remove`,
`purge` and `autoremove`, `dpkg --purge`, `reboot`, `poweroff`, `halt` and
`shutdown` in command position, the `systemctl` power verbs, a redirect onto a
block device, `mkswap` and `swapoff`, and `pvesm free`. `upload` and
`download` bypass the policy.

The helpers build argument vectors with `shJoin`, run with `check: true`, and
parse what the tools print. `zfs.ts` wraps `zpool` and `zfs` and parses `zpool
status` into a device tree and the `-Hp` list output into records.
`systemd.ts` queries through `systemctl show` and writes unit files and
drop-ins under `/etc/systemd/system`. `packages.ts` runs `apt-get`
non-interactively with `--force-confdef --force-confold`, parses `apt list`,
`apt-get -s`, `apt-cache policy` and `apt-cache show`, and writes source files
and keyrings. `qemu.ts` wraps `qm` and `lxc.ts` wraps `pct`; both parse the
`key: value` config listing, and `pct` moves files between this machine and a
container through a temporary file on the node.

## The facade

`src/pve/` is the surface a caller reaches for. `connect()` builds one
`PveCluster` from the credentials, checks them with `GET /version`, and every
node, guest and console handle hangs off it.

```ts
class PveCluster implements PveContext {
	readonly client: PveClient
	readonly api: ClusterApi
	readonly access: AccessApi
	version(): Promise<PveVersion>
	nodes(): Promise<NodeListEntry[]>
	node(name?: string): PveNode
	list(options?: ListGuestsOptions): Promise<GuestSummary[]>
	guest(vmid: number): Promise<PveGuest>
	vm(vmid: number, node?: string): PveVm
	container(vmid: number, node?: string): PveContainer
	nextId(vmid?: number): Promise<number>
	createVm(spec: CreateVmSpec): Promise<PveVm>
	createContainer(spec: CreateContainerSpec): Promise<PveContainer>
	waitForTask(upid: string, options?: WaitOptions): Promise<TaskStatus>
	nodeShell(node: string): Promise<NodeShell>
	vncSession(ref: Required<GuestRef>): Promise<VncSession>
	closeVncSession(vmid: number): Promise<void>
	serialConsole(ref: Required<GuestRef>, options?: SerialOpenOptions): Promise<SerialConsole>
	closeSerialConsole(vmid: number): Promise<void>
	close(): Promise<void>
	[Symbol.asyncDispose](): Promise<void>
}
```

A handle is a value object holding a name and a vmid; making one sends
nothing. `node()`, `vm()` and `container()` default the node to `PVE_NODE` and
throw `PveConfigError` when neither is set.

The sessions a handle reaches for belong to the cluster and are keyed by vmid
or node name in a `SessionStore`: one open per key is in flight at a time, so
concurrent callers share a handshake; a failed open leaves no entry behind, so
the next call tries again; and a session that closes underneath forgets its
own entry. `close()` drains the three stores, closes every VNC session, serial
console and node shell, then releases the client. It is safe to call twice.
Two clusters in one process share nothing.

`PveContext` is what a handle needs from the cluster: the client and the five
session methods. `PveNode`, `PveVm` and `PveContainer` hold a context, not a
`PveCluster`, so the facade tests build them over fakes.

Where the facade adds something, the accessor is an object with methods:
`vm.kvm` (`VmKvm`) and `guest.console` (`GuestConsole`) connect on the first
call and hand the session underneath back through `session()`. Where the
module object is already the right thing, the accessor is that object once its
transport is open, so it is awaited: `await node.shell`, `await ct.shell`,
`await vm.os`, `await ct.os`. A failed `os` open is retried on the next await.

`guest.api` is the module handle underneath a guest (`QemuApi` or `LxcApi`),
and its lifecycle calls return the raw UPID rather than waiting. `delete` on a
handle closes the guest's console sessions first, since a destroyed guest's
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
bridge, pool and guests the suite expects, opens one connection per file, and
removes the scratch guests before and after a run. `PVE_LIVE_ALL=1` adds the
Windows and macOS guest groups.

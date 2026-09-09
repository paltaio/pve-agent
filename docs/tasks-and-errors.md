# Tasks and errors

## UPIDs

Anything PVE runs in the background answers with a UPID rather than a
result:

```
UPID:pve1:00001A2B:0004C3D5:68B4F0A1:qmstart:9001:root@pam!automation:
```

The UPID names the node that runs the task, so none of the task calls take a
node argument.

```ts
import { isUpid, parseUpid } from 'pve-agent'

const upid = 'UPID:pve1:00001A2B:0004C3D5:68B4F0A1:qmstart:9001:root@pam!automation:'
console.log(isUpid(upid))
const parsed = parseUpid(upid) // { node, pid, pstart, startTime, type, id, user, upid }
console.log(parsed.node, parsed.type, parsed.id)
```

The facade waits for you. `vm.start()` returns the final `TaskStatus`, not
the UPID. When you want the UPID, go through `guest.api`:

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()

const upid = await cluster.vm(100).api.start()
const status = await cluster.waitForTask(upid)
console.log(status.exitStatus, status.outcome)
```

## Waiting

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()
const controller = new AbortController()
const upid = await cluster.vm(100).api.start()

const status = await cluster.waitForTask(upid, {
	timeoutMs: 10 * 60_000,
	initialDelayMs: 200,
	maxDelayMs: 2000,
	failOnWarnings: false,
	errorLogLines: 25,
	signal: controller.signal,
	onPoll: (s) => console.error(s.status, s.exitStatus),
})
console.log(status.upid, status.node, status.type, status.id, status.user, status.pid, status.startTime)
```

Polling starts at 200 ms and doubles to 2 s. On failure it throws
`PveTaskError` carrying the exit status and the last 25 lines of the task
log, so the message says why the task failed rather than that it failed.

`WARNINGS: n` is a success status. PVE treats it that way and so does
`waitForTask`; `failOnWarnings: true` turns it into a failure.

`status.outcome` is `'ok'`, `'warning'`, `'error'` or `'unknown'`.

Running several at once:

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()
const guests = [cluster.vm(100), cluster.vm(101), cluster.container(110)]

const upids = await Promise.all(guests.map((guest) => guest.api.start()))
const results = await Promise.allSettled(upids.map((upid) => cluster.waitForTask(upid)))
console.log(results.map((result) => result.status))
```

## Status and logs

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()
const upid = await cluster.vm(100).api.start()

await cluster.client.taskStatus(upid)
await cluster.client.taskLog(upid) // whole log
await cluster.client.taskLog(upid, { start: 0, limit: 50 })
```

The log endpoint caps a request at 50 lines when no limit is given, so an
omitted limit is sent as 0, which reads to the end.

Listing and stopping:

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()
const node = cluster.node('pve1')

await cluster.api.tasks() // every node, newest first
await node.tasks({ limit: 50, errors: true, typefilter: 'qmstart' })
const page = await node.api.tasks.page({ start: 0, limit: 50 }) // with the total count
console.log(page.total)
const running = await node.api.tasks.list({ source: 'active' })
for (const task of running) await node.api.tasks.stop(task.upid)
```

A list row is a `TaskListEntry`:

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()

for (const task of await cluster.api.tasks()) {
	console.log(task.upid, task.status, task.exitStatus ?? 'running', task.outcome, task.endTime)
}
```

On a list row and on a status read alike, `status` is the run state,
`'running'` or `'stopped'`, and `exitStatus` is the exit status, null while
the task runs. `pid` is absent on `/cluster/tasks` rows, which do not carry
one.

## Guest state is not task state

A start or stop task can finish before the guest has settled. Wait on the
guest:

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()
const vm = cluster.vm(100)

await vm.start() // the task is done
await vm.waitFor('running') // the guest is
```

`waitFor` polls `status/current` and folds a QEMU pause into `'paused'`.

## The error tree

Every class extends `PveError`, which carries a `kind` so a caller can switch
on one field:

```ts
import pve, { PveError } from 'pve-agent'

await using cluster = await pve.connect()

try {
	await cluster.vm(100).start()
} catch (error) {
	if (!(error instanceof PveError)) throw error
	switch (error.kind) {
		case 'tier':
		case 'permission':
			console.error('credentials:', error.message)
			break
		case 'task':
			console.error('the worker failed:', error.message)
			break
		default:
			throw error
	}
}
```

| Class | `kind` | Raised when | Carries |
| --- | --- | --- | --- |
| `PveConfigError` | `config` | A credential or a parameter value is missing or unusable | |
| `PveConnectionError` | `connection` | DNS, TCP, TLS or a timeout | `url` |
| `PveAuthError` | `auth` | The API rejected the credentials | `tier` |
| `PveTierError` | `tier` | The call needs a credential this client does not hold | `required`, `available` |
| `PvePermissionError` | `permission` | 403 with credentials that were accepted | `method`, `path`, `tier` |
| `PveNotFoundError` | `not-found` | 404, 501, a path outside the registry, or the 500 PVE sends for a missing guest or config file | `method`, `path` |
| `PveApiError` | `api` | Any other non-2xx, or a 2xx whose body is not JSON | `status`, `method`, `path`, `errors` |
| `PveTaskError` | `task` | A worker task failed, or the wait gave up on one | `upid`, `exitStatus`, `timedOut`, `log` |
| `PveTimeoutError` | `timeout` | A poll gave up: a guest never reached a state, an agent never answered, a screen never appeared, a serial console never printed the text | `what`, `waitedMs` |
| `GuestCommandError` | `guest-command` | A command inside a guest exited non-zero | `vmid`, `exitCode`, `stdout`, `stderr` |
| `PvePropertyError` | `property` | A property string does not fit its format | |
| `PveConsoleError` | `console` | A console transport or protocol failure, or a refused login | |
| `PveShellError` | `shell` | The root-shell layer failed | `shell` |

Waiting on a task and waiting on a state are different failures.
`PveTaskError` belongs to a real worker task and names its UPID;
`PveTimeoutError` is what `guest.waitFor`, `vm.waitForAgent`,
`kvm.waitForScreen`, `console.waitForText` and the guest-command deadline
throw, and it names what was being waited for.

## Reading each one

### PveTierError

Thrown before anything goes out, so it costs nothing and says what is
missing:

```ts
import pve, { PveTierError } from 'pve-agent'

await using cluster = await pve.connect()

try {
	await cluster.node('pve1').api.disks.wipe('/dev/sdz')
} catch (error) {
	if (error instanceof PveTierError) {
		console.error(error.required) // 'ticket'
		console.error(error.available) // ['token']
		console.error(error.message) // names the environment variable to set
	}
}
```

Check first, without catching:

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()

const decision = cluster.client.requiredTier('POST', '/nodes/pve1/execute')
if (decision.requiresRootPam && !cluster.client.auth.hasRootTicket) {
	console.log('take the shell path')
}
```

### PveApiError

PVE reports per-parameter validation failures, and they end up in `errors`:

```ts
import pve, { PveApiError } from 'pve-agent'

await using cluster = await pve.connect()

try {
	await cluster.vm(100).configure({ memory: 'lots' })
} catch (error) {
	if (error instanceof PveApiError) {
		console.error(error.status) // 400
		for (const [param, message] of Object.entries(error.errors)) {
			console.error(`${param}: ${message}`)
		}
	}
}
```

### PveNotFoundError

Four different things land here: a 404, a 501, a path that is not in the
generated registry, and the 500 PVE answers when a guest or a config file
does not exist. The last one is why `rrddata` on a guest created a minute ago
throws this rather than returning an empty list:

```ts
import pve, { PveNotFoundError } from 'pve-agent'

await using cluster = await pve.connect()

try {
	await cluster.vm(100).api.rrddata({ timeframe: 'hour' })
} catch (error) {
	if (!(error instanceof PveNotFoundError)) throw error
	// pvestatd has not written the first sample yet
}
```

A path outside the registry is usually a typo. Send it anyway with
`{ allowUnknownEndpoint: true }` when it is not.

### PveTaskError

```ts
import pve, { PveTaskError } from 'pve-agent'

await using cluster = await pve.connect()

try {
	await cluster.vm(100).start()
} catch (error) {
	if (error instanceof PveTaskError) {
		console.error(error.upid)
		console.error(error.exitStatus) // the PVE error line, or null on a timeout
		console.error(error.timedOut) // the worker is still running
		console.error(error.log.join('\n')) // the last lines of the task log
	}
}
```

`timedOut` is true when the wait gave up and the worker is still running, in
which case `exitStatus` is null; poll it again with `taskStatus` or end it
with `node.api.tasks.stop(upid)`.

### PveTimeoutError

```ts
import pve, { PveTimeoutError } from 'pve-agent'

await using cluster = await pve.connect()

try {
	await cluster.vm(100).waitFor('running', { timeoutMs: 30_000 })
} catch (error) {
	if (error instanceof PveTimeoutError) {
		console.error(error.what) // 'qemu 100 to be running'
		console.error(error.waitedMs)
	}
}
```

Thrown by `guest.waitFor`, `vm.waitForAgent`, `kvm.waitForScreen`,
`console.waitForText`, `console.waitForPrompt`, `console.login` and a guest
command that outlives its deadline. Nothing here has a UPID, so nothing here
carries one.

### GuestCommandError

```ts
import pve, { GuestCommandError } from 'pve-agent'

await using cluster = await pve.connect()
const os = await cluster.vm(100).os

try {
	await os.output('systemctl is-active nginx')
} catch (error) {
	if (error instanceof GuestCommandError) {
		console.error(error.vmid, error.exitCode)
		console.error(error.stderr || error.stdout)
	}
}
```

`run`, `sh` and `exec` return the exit code rather than throwing; `output`
and the file helpers throw.

### PveShellCommandError

```ts
import pve, { PveShellCommandError } from 'pve-agent'

await using cluster = await pve.connect()
const shell = await cluster.node('pve1').shell

try {
	await shell.output('zpool status nosuchpool')
} catch (error) {
	if (error instanceof PveShellCommandError) {
		console.error(error.node, error.command, error.exitCode)
		console.error(error.stderr || error.stdout)
	}
}
```

`shell.run` returns the exit code rather than throwing. `check: true` and
`shell.output` throw. The other four shell classes are in
[shell.md](shell.md).

## Tracing

`onRequest` fires before every attempt, including the retry after a stale
ticket:

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect({
	onRequest: (trace) => {
		console.error(
			`#${trace.attempt} ${trace.decision.tier}${trace.escalated ? ' escalated' : ''} ` +
				`${trace.method} ${trace.path}`,
		)
	},
})
```

For the shell layer, `shell.policy.explain(command)` answers what the policy
would decide. See [shell.md](shell.md).

## Retries the library already does

- A ticket in its last quarter hour is renewed before the call, and one 403
  on a ticket call triggers a fresh login and a single retry.
- A call whose tier decision says `ticket` while only a token is configured
  throws rather than trying and failing.

Everything else is yours. A task that failed is not retried, and a command
that exited non-zero is not run again.

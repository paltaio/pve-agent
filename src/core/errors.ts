/**
 * Error hierarchy for the PVE client.
 *
 * Each class carries the fields a caller branches on: the missing credential,
 * the privilege the endpoint wanted, the task exit status.
 */

/** Authentication mechanisms the client can present to the API. */
export type AuthTier = 'token' | 'ticket'

export type PveErrorKind =
	| 'config'
	| 'connection'
	| 'auth'
	| 'tier'
	| 'permission'
	| 'not-found'
	| 'api'
	| 'task'
	| 'timeout'
	| 'property'
	| 'console'
	| 'guest-command'
	| 'shell'

export class PveError extends Error {
	readonly kind: PveErrorKind

	constructor(kind: PveErrorKind, message: string, options?: { cause?: unknown }) {
		super(message, options)
		this.kind = kind
		this.name = new.target.name
	}
}

/** Credentials or connection settings are missing or malformed. */
export class PveConfigError extends PveError {
	constructor(message: string) {
		super('config', message)
	}
}

/**
 * The request never reached the API: DNS, TCP, TLS, or timeout.
 *
 * `url` carries no query string: a GET or DELETE puts its parameters there,
 * and some of those are passwords.
 */
export class PveConnectionError extends PveError {
	readonly url: string

	constructor(url: string, cause: unknown) {
		const detail = cause instanceof Error ? cause.message : String(cause)
		const shown = url.split('?', 1)[0] ?? url
		super(
			'connection',
			`Cannot reach ${shown}: ${detail}. Check PVE_HOST/PVE_PORT, that the node is up, and PVE_VERIFY_SSL if the node uses a self-signed certificate.`,
			{ cause },
		)
		this.url = shown
	}
}

/** The API rejected the credentials themselves. */
export class PveAuthError extends PveError {
	readonly tier: AuthTier

	constructor(tier: AuthTier, detail: string) {
		const fix =
			tier === 'ticket'
				? 'Check PVE_USER and PVE_PASSWORD.'
				: 'Check PVE_TOKEN_ID and PVE_TOKEN_SECRET.'
		super('auth', `PVE rejected the ${tier} credentials: ${detail}. ${fix}`)
		this.tier = tier
	}
}

/**
 * The call needs a credential tier the client was not given. Raised before the
 * request goes out, so the caller gets a named missing credential instead of a
 * 403 from the server.
 */
export class PveTierError extends PveError {
	readonly required: AuthTier
	readonly available: readonly AuthTier[]

	constructor(args: {
		required: AuthTier
		available: readonly AuthTier[]
		method: string
		path: string
		reason: string
	}) {
		const need =
			args.required === 'ticket'
				? 'a root@pam ticket (set PVE_USER=root@pam and PVE_PASSWORD)'
				: 'an API token (set PVE_TOKEN_ID and PVE_TOKEN_SECRET)'
		super(
			'tier',
			`${args.method} ${args.path} needs ${need}: ${args.reason}. Available credentials: ${
				args.available.length > 0 ? args.available.join(', ') : 'none'
			}.`,
		)
		this.required = args.required
		this.available = args.available
	}
}

/** The API answered 403 with credentials that were accepted but not privileged. */
export class PvePermissionError extends PveError {
	readonly method: string
	readonly path: string
	readonly tier: AuthTier

	constructor(args: { method: string; path: string; tier: AuthTier; detail: string }) {
		super(
			'permission',
			`${args.method} ${args.path} denied for the ${args.tier} credential: ${args.detail}. Grant the role on the affected path, or supply a root@pam ticket if the endpoint or a parameter is root-only.`,
		)
		this.method = args.method
		this.path = args.path
		this.tier = args.tier
	}
}

/** The path, node, guest, or object does not exist. */
export class PveNotFoundError extends PveError {
	readonly method: string
	readonly path: string

	constructor(args: { method: string; path: string; detail: string }) {
		super('not-found', `${args.method} ${args.path} not found: ${args.detail}`)
		this.method = args.method
		this.path = args.path
	}
}

/** Any other non-2xx answer from the API. */
export class PveApiError extends PveError {
	readonly status: number
	readonly method: string
	readonly path: string
	/** Per-parameter validation messages PVE returns for malformed requests. */
	readonly errors: Readonly<Record<string, string>>

	constructor(args: {
		status: number
		method: string
		path: string
		detail: string
		errors?: Record<string, string>
	}) {
		const fields =
			args.errors && Object.keys(args.errors).length > 0
				? ` Parameter errors: ${Object.entries(args.errors)
						.map(([key, value]) => `${key}: ${value}`)
						.join('; ')}`
				: ''
		super('api', `${args.method} ${args.path} failed (${args.status}): ${args.detail}.${fields}`)
		this.status = args.status
		this.method = args.method
		this.path = args.path
		this.errors = args.errors ?? {}
	}
}

/**
 * A worker task finished with a non-OK exit status, or outlived a wait.
 *
 * `upid` is always a real UPID, so `client.taskStatus(err.upid)`,
 * `taskLog` and `stopTask` all work on it.
 */
export class PveTaskError extends PveError {
	readonly upid: string
	/** 'OK', 'WARNINGS: n' or an error line. Null when the task never finished. */
	readonly exitStatus: string | null
	/** True when the wait gave up and the worker is still running. */
	readonly timedOut: boolean
	readonly log: readonly string[]

	constructor(args: {
		upid: string
		exitStatus: string | null
		timedOut?: boolean
		/** Replaces the exit status in the message, for a task that has none yet. */
		detail?: string
		log?: readonly string[]
	}) {
		const log = args.log ?? []
		const tail = log.length > 0 ? `\nTask log tail:\n${log.join('\n')}` : ''
		const what = args.detail ?? args.exitStatus ?? 'no exit status'
		const verb = args.timedOut === true ? 'is' : 'finished with:'
		const cause = firstErrorLine(log, args.exitStatus)
		super('task', `Task ${args.upid} ${verb} ${what}${cause ? ` (${cause})` : ''}${tail}`)
		this.upid = args.upid
		this.exitStatus = args.exitStatus
		this.timedOut = args.timedOut === true
		this.log = args.log ?? []
	}
}

/**
 * The first `ERROR:` line of a task log, without its timestamp, when it
 * says more than the exit status does. A migration ends with "migration
 * aborted" while the line that names the missing bridge sits higher up.
 */
function firstErrorLine(log: readonly string[], exitStatus: string | null): string | undefined {
	for (const line of log) {
		const match = /(?:^|\s)ERROR:\s*(.+)$/.exec(line)
		if (!match) continue
		const text = match[1]?.trim()
		if (!text || (exitStatus !== null && exitStatus.includes(text))) continue
		return text
	}
	return undefined
}

/** A condition the caller waited for did not hold before the deadline. */
export class PveTimeoutError extends PveError {
	/** What was being waited for, such as `lxc 110 to be running`. */
	readonly what: string
	readonly waitedMs: number

	constructor(args: { what: string; waitedMs: number; detail?: string }) {
		const detail = args.detail ? `; ${args.detail}` : ''
		super(
			'timeout',
			`Timed out after ${Math.round(args.waitedMs / 1000)}s waiting for ${args.what}${detail}`,
		)
		this.what = args.what
		this.waitedMs = args.waitedMs
	}
}

/** A property string could not be parsed or serialized against its format. */
export class PvePropertyError extends PveError {
	constructor(message: string) {
		super('property', message)
	}
}

/** A console transport or protocol failure. */
export class PveConsoleError extends PveError {
	constructor(message: string, options?: { cause?: unknown }) {
		super('console', message, options)
	}
}

/** A command run inside a guest exited non-zero. */
export class GuestCommandError extends PveError {
	readonly vmid: number
	readonly exitCode: number
	readonly stdout: string
	readonly stderr: string

	constructor(args: {
		vmid: number
		/** What ran, such as `apt-get install curl`. */
		what: string
		exitCode: number
		stdout: string
		stderr: string
	}) {
		super(
			'guest-command',
			`${args.what} in guest ${args.vmid} exited ${args.exitCode}: ${
				args.stderr.trim() || args.stdout.trim() || 'no output'
			}`,
		)
		this.vmid = args.vmid
		this.exitCode = args.exitCode
		this.stdout = args.stdout
		this.stderr = args.stderr
	}
}

/**
 * The guest agent stopped a command's output at its cap, so a value read
 * from that output is incomplete.
 */
export class GuestOutputTruncatedError extends PveError {
	readonly vmid: number

	constructor(args: { vmid: number; what: string }) {
		super(
			'guest-command',
			`${args.what} in guest ${args.vmid} produced more output than the agent carries in one command, so the result is incomplete`,
		)
		this.vmid = args.vmid
	}
}

/** Which way the root-shell layer failed. */
export type ShellErrorKind =
	/** No credential can open a root shell on the node. */
	| 'credential'
	/** The transport could not be opened or dropped mid-command. */
	| 'transport'
	/** The shell policy refused the command. */
	| 'policy'
	/** The command ran and exited non-zero. */
	| 'command'
	/** The command ran but printed something the helper cannot read. */
	| 'output'
	/** The command produced no result before its deadline. */
	| 'timeout'

/** The root-shell layer failed; `shell` says which way. */
export class PveShellError extends PveError {
	readonly shell: ShellErrorKind

	constructor(shell: ShellErrorKind, message: string, options?: { cause?: unknown }) {
		super('shell', message, options)
		this.shell = shell
	}
}

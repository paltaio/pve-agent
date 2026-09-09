/**
 * Root shell over the system ssh binary: the command's own exit code, stdout
 * and stderr kept apart, arbitrary bytes in both directions, and scp for file
 * transfer. It needs a key authorised for root on the node.
 */

import { PveShellCommandError, PveShellTimeoutError, PveShellTransportError } from './errors.ts'
import { shWrap } from './escape.ts'
import { spawnProcess, type SpawnFn, type SpawnResult } from './spawn.ts'
import type { CommandResult, RunOptions, ShellTransport } from './types.ts'

export interface SshOptions {
	/** Address or hostname of the node. */
	host: string
	/** Node name this transport reports. Defaults to the host. */
	node?: string
	/** Defaults to root. */
	user?: string
	port?: number
	identityFile?: string
	knownHostsFile?: string
	/** Defaults to accept-new. */
	strictHostKeyChecking?: 'yes' | 'no' | 'accept-new'
	/** Defaults to 10. */
	connectTimeoutSeconds?: number
	/**
	 * Socket path for connection multiplexing. Set it to reuse one TCP session
	 * across commands; leaving it unset opens a connection per command.
	 */
	controlPath?: string
	/** Defaults to 60. */
	controlPersistSeconds?: number
	/** Extra `ssh` arguments, inserted before the destination. */
	extraArgs?: readonly string[]
	sshBinary?: string
	scpBinary?: string
	/**
	 * Run scp in SFTP mode (`scp -s`), where the remote path is taken as
	 * written. Off, scp's own default applies: OpenSSH 9.0 and later use SFTP
	 * mode, earlier releases hand the remote path to root's shell on the node,
	 * which expands globs, variables and substitutions in it.
	 */
	sftp?: boolean
	/** Defaults to 120000. */
	defaultTimeoutMs?: number
	/** Replaced by tests. */
	spawn?: SpawnFn
}

const DEFAULT_TIMEOUT_MS = 120_000

/**
 * ssh's own failures use exit 255 and name themselves at the start of a
 * stderr line. A remote command that writes 'Permission denied' of its own
 * writes it behind its own name, so the anchors keep the two apart.
 */
const SSH_FAILURE =
	/^ssh: |^[^\s:@]+@[^\s:]+: Permission denied|^Host key verification failed|^Could not resolve hostname|^Connection (refused|timed out|closed)|^Operation timed out/m

export class SshTransport implements ShellTransport {
	readonly kind = 'ssh' as const
	readonly node: string

	private readonly options: SshOptions
	private readonly spawn: SpawnFn
	private readonly defaultTimeoutMs: number

	constructor(options: SshOptions) {
		this.options = options
		this.node = options.node ?? options.host
		this.spawn = options.spawn ?? spawnProcess
		this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS
	}

	get description(): string {
		const port = this.options.port === undefined ? '' : ` -p ${this.options.port}`
		return `ssh ${this.destination}${port}`
	}

	private get destination(): string {
		return `${this.options.user ?? 'root'}@${this.options.host}`
	}

	/** Run a command line under root's login shell on the node. */
	async run(command: string, options: RunOptions = {}): Promise<CommandResult> {
		const started = Date.now()
		const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs
		const result = await this.spawnChecked(this.argv(shWrap(command, options)), {
			input: toBytes(options.input),
			timeoutMs,
		})

		const stdout = decode(result.stdout)
		const stderr = decode(result.stderr)
		if (result.timedOut) {
			throw new PveShellTimeoutError({
				node: this.node,
				command,
				timeoutMs,
				partialOutput: stdout || stderr,
			})
		}
		this.assertTransport(result, stderr, command)
		if (options.check === true && result.exitCode !== 0) {
			throw new PveShellCommandError({
				node: this.node,
				command,
				exitCode: result.exitCode,
				stdout,
				stderr,
			})
		}
		return { stdout, stderr, exitCode: result.exitCode, durationMs: Date.now() - started }
	}

	/**
	 * Copy a local file onto the node with scp, replacing the remote path.
	 * Unless scp runs in SFTP mode, the remote shell expands the remote path.
	 */
	async upload(localPath: string, remotePath: string): Promise<void> {
		await this.scp(localPath, `${this.destination}:${remotePath}`)
	}

	/**
	 * Copy a file off the node with scp, replacing the local path. Unless scp
	 * runs in SFTP mode, the remote shell expands the remote path.
	 */
	async download(remotePath: string, localPath: string): Promise<void> {
		await this.scp(`${this.destination}:${remotePath}`, localPath)
	}

	/** Closes the multiplexed connection when one is configured. */
	async close(): Promise<void> {
		if (this.options.controlPath === undefined) return
		await this.spawnChecked(
			[
				this.options.sshBinary ?? 'ssh',
				...this.connectionArgs(),
				'-O',
				'exit',
				'--',
				this.destination,
			],
			{ timeoutMs: 5000 },
		).catch(() => undefined)
	}

	/** The ssh argument vector for a command line. */
	argv(command: string): string[] {
		return [
			this.options.sshBinary ?? 'ssh',
			...this.connectionArgs(),
			'--',
			this.destination,
			command,
		]
	}

	private connectionArgs(): string[] {
		const options = this.options
		const args = [
			'-o',
			'BatchMode=yes',
			'-o',
			`StrictHostKeyChecking=${options.strictHostKeyChecking ?? 'accept-new'}`,
			'-o',
			`ConnectTimeout=${options.connectTimeoutSeconds ?? 10}`,
		]
		if (options.knownHostsFile !== undefined) {
			args.push('-o', `UserKnownHostsFile=${options.knownHostsFile}`)
		}
		if (options.identityFile !== undefined) {
			args.push('-o', 'IdentitiesOnly=yes', '-i', options.identityFile)
		}
		if (options.controlPath !== undefined) {
			args.push(
				'-o',
				'ControlMaster=auto',
				'-o',
				`ControlPersist=${options.controlPersistSeconds ?? 60}`,
				'-o',
				`ControlPath=${options.controlPath}`,
			)
		}
		if (options.port !== undefined) args.push('-p', String(options.port))
		if (options.extraArgs) args.push(...options.extraArgs)
		return args
	}

	private async scp(source: string, destination: string): Promise<void> {
		const args = this.connectionArgs()
		// scp takes the port with a capital P.
		const portIndex = args.indexOf('-p')
		if (portIndex !== -1) args[portIndex] = '-P'
		if (this.options.sftp === true) args.push('-s')
		// The operands follow --, so a path that starts with a dash stays a path.
		const argv = [this.options.scpBinary ?? 'scp', '-q', ...args, '--', source, destination]
		const result = await this.spawnChecked(argv, { timeoutMs: this.defaultTimeoutMs })
		if (result.exitCode !== 0) {
			throw new PveShellTransportError({
				node: this.node,
				transport: 'ssh',
				message: `scp ${source} -> ${destination} failed (${result.exitCode}): ${decode(result.stderr).trim() || 'no output'}`,
			})
		}
	}

	private assertTransport(result: SpawnResult, stderr: string, command: string): void {
		if (result.exitCode === 255 && SSH_FAILURE.test(stderr)) {
			throw new PveShellTransportError({
				node: this.node,
				transport: 'ssh',
				message: `${this.description} could not run a command: ${stderr.trim()}\nCommand: ${command}`,
			})
		}
	}

	private async spawnChecked(
		argv: readonly string[],
		options: { input?: Uint8Array | undefined; timeoutMs?: number },
	): Promise<SpawnResult> {
		try {
			return await this.spawn({
				argv,
				...(options.input === undefined ? {} : { input: options.input }),
				...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
			})
		} catch (cause) {
			throw new PveShellTransportError({
				node: this.node,
				transport: 'ssh',
				message: `Cannot run ${argv[0]}: ${cause instanceof Error ? cause.message : String(cause)}`,
				cause,
			})
		}
	}
}

export interface SshProbe {
	ok: boolean
	/** ssh's own diagnostic when the probe failed. */
	detail: string
}

/**
 * Check whether ssh reaches the node without a password. Runs `true` on the
 * node, so it changes nothing.
 */
export async function probeSsh(options: SshOptions): Promise<SshProbe> {
	const transport = new SshTransport({ ...options, defaultTimeoutMs: 15_000 })
	try {
		const result = await transport.run('true')
		return result.exitCode === 0
			? { ok: true, detail: '' }
			: { ok: false, detail: result.stderr.trim() || `exit ${result.exitCode}` }
	} catch (error) {
		// The transport error repeats the probe command, which says nothing here.
		const detail = error instanceof Error ? error.message : String(error)
		return { ok: false, detail: detail.split('\n')[0] ?? detail }
	}
}

function toBytes(value: string | Uint8Array | undefined): Uint8Array | undefined {
	if (value === undefined) return undefined
	return typeof value === 'string' ? new TextEncoder().encode(value) : value
}

function decode(bytes: Uint8Array): string {
	return new TextDecoder().decode(bytes)
}

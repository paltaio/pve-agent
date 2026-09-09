/**
 * One root shell on one node, with the policy in front of it.
 *
 * Everything the PVE API cannot express runs through `run`, `output` and the
 * two file transfers. `open` picks the transport: SSH when a key works, the
 * termproxy websocket when the client holds a root@pam ticket.
 */

import type { PveClient } from '../core/client.ts'
import { PveShellCredentialError, PveShellPolicyError, PveShellTransportError } from './errors.ts'
import { PctShell } from './lxc.ts'
import { AptShell } from './packages.ts'
import { CommandPolicy, commandPrograms } from './policy.ts'
import { QmShell } from './qemu.ts'
import { probeSsh, SshTransport, type SshOptions } from './ssh.ts'
import { SystemdShell } from './systemd.ts'
import { openTermproxy, type TermproxyOptions } from './termproxy.ts'
import type {
	CommandResult,
	RunOptions,
	ShellPolicy,
	ShellTransport,
	ShellTransportKind,
} from './types.ts'
import { ZfsShell } from './zfs.ts'

export type TransportChoice = 'auto' | ShellTransportKind

export interface NodeShellOptions {
	/** Node name as PVE knows it. Also the default ssh host. */
	node: string
	/** 'auto', the default, prefers ssh and falls back to termproxy. */
	transport?: TransportChoice
	/** SSH settings. `host` defaults to the node name. */
	ssh?: Partial<SshOptions>
	/** Needed for the termproxy transport, ignored by ssh. */
	client?: PveClient
	termproxy?: Omit<TermproxyOptions, 'client' | 'node'>
	policy?: ShellPolicy
}

export class NodeShell {
	readonly node: string
	readonly transport: ShellTransport
	readonly policy: CommandPolicy

	readonly zfs: ZfsShell
	readonly systemd: SystemdShell
	readonly apt: AptShell
	readonly qm: QmShell
	readonly pct: PctShell

	private readonly closeListeners: (() => void)[] = []
	private closed = false

	constructor(transport: ShellTransport, policy: ShellPolicy = {}) {
		this.node = transport.node
		this.transport = transport
		this.policy = new CommandPolicy(policy)
		this.zfs = new ZfsShell(this)
		this.systemd = new SystemdShell(this)
		this.apt = new AptShell(this)
		this.qm = new QmShell(this)
		this.pct = new PctShell(this)
	}

	/** Open a shell on a node, picking the transport. */
	static async open(options: NodeShellOptions): Promise<NodeShell> {
		return new NodeShell(await selectTransport(options), options.policy ?? {})
	}

	get kind(): ShellTransportKind {
		return this.transport.kind
	}

	/**
	 * Run a command line as root on the node. The policy sees the command
	 * first and can refuse it; when the command runs an interpreter, the
	 * policy reads `input` as command lines too. Returns the exit code rather
	 * than throwing, unless `check` is set.
	 */
	async run(command: string, options: RunOptions = {}): Promise<CommandResult> {
		this.policy.check(command)
		if (options.input !== undefined && commandPrograms(command).some(isInterpreter)) {
			const input =
				typeof options.input === 'string' ? options.input : new TextDecoder().decode(options.input)
			const decision = this.policy.explain(input)
			if (!decision.allowed) {
				throw new PveShellPolicyError({
					command,
					reason: `the input feeds an interpreter and ${decision.reason}`,
				})
			}
		}
		try {
			return await this.transport.run(command, options)
		} catch (error) {
			if (error instanceof PveShellTransportError) this.notifyClosed()
			throw error
		}
	}

	/** Run a command and return its trimmed stdout, throwing when it exits non-zero. */
	async output(command: string, options: RunOptions = {}): Promise<string> {
		const result = await this.run(command, { ...options, check: true })
		return result.stdout.trim()
	}

	/** Copy a local file onto the node, replacing the remote path. The policy does not see it. */
	upload(localPath: string, remotePath: string): Promise<void> {
		return this.transport.upload(localPath, remotePath)
	}

	/** Copy a file from the node to this machine, replacing the local path. */
	download(remotePath: string, localPath: string): Promise<void> {
		return this.transport.download(remotePath, localPath)
	}

	/**
	 * Called once, when the shell is closed or its transport fails to carry a
	 * command. A holder that caches shells drops this one on it.
	 */
	onClose(listener: () => void): void {
		this.closeListeners.push(listener)
	}

	async close(): Promise<void> {
		this.notifyClosed()
		await this.transport.close()
	}

	private notifyClosed(): void {
		if (this.closed) return
		this.closed = true
		for (const listener of this.closeListeners) listener()
	}
}

/**
 * Pick a transport. 'auto' probes ssh first and falls back to termproxy when
 * the client holds a root@pam ticket.
 */
export async function selectTransport(options: NodeShellOptions): Promise<ShellTransport> {
	const choice = options.transport ?? 'auto'
	const sshOptions: SshOptions = {
		...options.ssh,
		host: options.ssh?.host ?? options.node,
		node: options.node,
	}
	const sshTarget = `${sshOptions.user ?? 'root'}@${sshOptions.host}`

	if (choice === 'termproxy') {
		return openTermproxy({
			client: requireClient(options),
			node: options.node,
			...options.termproxy,
		})
	}

	const probe = await probeSsh(sshOptions)
	if (probe.ok) return new SshTransport(sshOptions)

	if (choice === 'ssh') {
		throw new PveShellCredentialError(
			options.node,
			`No root shell on ${options.node}: ssh to ${sshTarget} failed (${probe.detail}). Authorise a key for root on the node, or pass a PveClient with a root@pam ticket and use the termproxy transport.`,
		)
	}

	const client = options.client
	if (client?.auth.hasRootTicket === true) {
		return openTermproxy({ client, node: options.node, ...options.termproxy })
	}

	const ticket =
		client === undefined
			? 'no API client'
			: `a ticket for ${client.auth.ticketUsername ?? 'no user'}`
	throw new PveShellCredentialError(
		options.node,
		[
			`No root shell on ${options.node}.`,
			`ssh to ${sshTarget} failed: ${probe.detail}.`,
			`The termproxy fallback needs a root@pam ticket and this caller has ${ticket}: POST /nodes/${options.node}/termproxy answers an API token or any other user with a /bin/login password prompt.`,
			'Authorise an SSH key for root on the node, or set PVE_USER=root@pam and PVE_PASSWORD.',
		].join(' '),
	)
}

const INTERPRETER = /^(sh|bash|dash|zsh|ksh|eval|xargs|python[0-9.]*|perl|ruby)$/

function isInterpreter(program: string): boolean {
	return INTERPRETER.test(program)
}

function requireClient(options: NodeShellOptions): PveClient {
	if (options.client === undefined) {
		throw new PveShellCredentialError(
			options.node,
			`The termproxy transport needs a PveClient to call POST /nodes/${options.node}/termproxy. Pass one, or use the ssh transport.`,
		)
	}
	return options.client
}

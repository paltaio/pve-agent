/**
 * The `pct` command line on the node.
 *
 * LXC has no counterpart to the QEMU guest agent, so running a command
 * inside a container, moving a file in or out of one, and clearing a stale
 * config lock all go through `pct`. `pct unlock` is the only way to clear a
 * lock: the config endpoint has no skiplock parameter and checks the lock
 * on every write.
 *
 * `pct enter` opens a login shell on a terminal and exits at once without
 * one; `exec` is the non-interactive path.
 */

import { parseSize } from '../core/props.ts'
import { assertSafeInteger, shJoin, shQuote } from './escape.ts'
import type { NodeShell } from './node-shell.ts'
import { parseGuestConfig } from './qemu.ts'
import type { CommandResult, RunOptions } from './types.ts'

export interface PctListEntry {
	vmid: number
	status: string
	/** The config lock, when one is held. */
	lock: string | undefined
	name: string
}

export interface PctExecOptions {
	/** Shell that interprets the command line inside the container. Defaults to sh. */
	shell?: string
	/** Pass the node's environment into the container. Defaults to pct's own default. */
	keepEnv?: boolean
	input?: string | Uint8Array
	timeoutMs?: number
}

export interface PctTransferOptions {
	/** Mode for the file inside the container, such as '0640'. */
	perms?: string
	/** Owner inside the container, as a uid or a name the container knows. */
	user?: number | string
	/** Group inside the container, as a gid or a name the container knows. */
	group?: number | string
	timeoutMs?: number
}

export interface PctDiskUsage {
	/** Mount point key from the config, such as 'rootfs' or 'mp0'. */
	mountPoint: string
	volume: string
	/** Sizes as pct prints them, such as '1.0G'. */
	size: string
	used: string
	available: string
	sizeBytes: number | undefined
	usedBytes: number | undefined
	availableBytes: number | undefined
	usePercent: number
	/** Path inside the container. */
	path: string
}

export class PctShell {
	private readonly shell: NodeShell

	constructor(shell: NodeShell) {
		this.shell = shell
	}

	/** Every container on the node, from `pct list`. */
	async list(): Promise<readonly PctListEntry[]> {
		return parsePctList(await this.shell.output('pct list'))
	}

	/** The config as PVE writes it, including the lock and any pending changes. */
	async config(
		vmid: number,
		options: { current?: boolean; snapshot?: string } = {},
	): Promise<Record<string, string>> {
		const argv = ['pct', 'config', vmidArg(vmid)]
		if (options.current) argv.push('--current', '1')
		if (options.snapshot !== undefined) argv.push('--snapshot', options.snapshot)
		return parseGuestConfig(await this.shell.output(shJoin(argv)))
	}

	/** The run state, such as 'running' or 'stopped'. */
	async status(vmid: number): Promise<string> {
		const output = await this.shell.output(shJoin(['pct', 'status', vmidArg(vmid)]))
		return /status:\s*(\S+)/.exec(output)?.[1] ?? output
	}

	start(vmid: number, options: { timeoutMs?: number } = {}): Promise<CommandResult> {
		return this.run(['pct', 'start', vmidArg(vmid)], options)
	}

	/** Kill the container. */
	stop(
		vmid: number,
		options: { overruleShutdown?: boolean; timeoutMs?: number } = {},
	): Promise<CommandResult> {
		const argv = ['pct', 'stop', vmidArg(vmid)]
		if (options.overruleShutdown) argv.push('--overrule-shutdown', '1')
		return this.run(argv, options)
	}

	/** Ask the container to shut down, and with `forceStop` kill it when it has not by the timeout. */
	shutdown(
		vmid: number,
		options: { timeoutSeconds?: number; forceStop?: boolean; timeoutMs?: number } = {},
	): Promise<CommandResult> {
		const argv = ['pct', 'shutdown', vmidArg(vmid)]
		if (options.timeoutSeconds !== undefined) {
			argv.push('--timeout', String(assertSafeInteger(options.timeoutSeconds, 'timeoutSeconds')))
		}
		if (options.forceStop) argv.push('--forceStop', '1')
		return this.run(argv, options)
	}

	reboot(
		vmid: number,
		options: { timeoutSeconds?: number; timeoutMs?: number } = {},
	): Promise<CommandResult> {
		const argv = ['pct', 'reboot', vmidArg(vmid)]
		if (options.timeoutSeconds !== undefined) {
			argv.push('--timeout', String(assertSafeInteger(options.timeoutSeconds, 'timeoutSeconds')))
		}
		return this.run(argv, options)
	}

	/**
	 * Run a command line inside the container through `pct exec`, which
	 * attaches to it and runs `sh -c`. The exit code is the command's own;
	 * a stopped container makes pct exit 255 with 'container is not running'.
	 */
	exec(vmid: number, command: string, options: PctExecOptions = {}): Promise<CommandResult> {
		return this.execArgv(vmid, [options.shell ?? 'sh', '-c', command], options)
	}

	/** Run a program inside the container with an explicit argument vector and no shell between. */
	execArgv(
		vmid: number,
		argv: readonly string[],
		options: PctExecOptions = {},
	): Promise<CommandResult> {
		const command = ['pct', 'exec', vmidArg(vmid)]
		if (options.keepEnv !== undefined) command.push('--keep-env', options.keepEnv ? '1' : '0')
		command.push('--', ...argv)
		const run: RunOptions = {}
		if (options.input !== undefined) run.input = options.input
		if (options.timeoutMs !== undefined) run.timeoutMs = options.timeoutMs
		return this.shell.run(shJoin(command), run)
	}

	/** Copy a file from the node into the container, replacing the target. */
	push(
		vmid: number,
		nodePath: string,
		containerPath: string,
		options: PctTransferOptions = {},
	): Promise<CommandResult> {
		const argv = ['pct', 'push', vmidArg(vmid), nodePath, containerPath, ...transferFlags(options)]
		return this.run(argv, options)
	}

	/** Copy a file from the container onto the node, replacing the target. */
	pull(
		vmid: number,
		containerPath: string,
		nodePath: string,
		options: PctTransferOptions = {},
	): Promise<CommandResult> {
		const argv = ['pct', 'pull', vmidArg(vmid), containerPath, nodePath, ...transferFlags(options)]
		return this.run(argv, options)
	}

	/** Copy a file from this machine into the container, through a temporary file on the node. */
	async pushLocalFile(
		vmid: number,
		localPath: string,
		containerPath: string,
		options: PctTransferOptions = {},
	): Promise<void> {
		const temp = await this.nodeTempFile()
		try {
			await this.shell.upload(localPath, temp)
			await this.push(vmid, temp, containerPath, options)
		} finally {
			await this.removeNodeFile(temp)
		}
	}

	/** Copy a file from the container onto this machine, through a temporary file on the node. */
	async pullToLocalFile(
		vmid: number,
		containerPath: string,
		localPath: string,
		options: PctTransferOptions = {},
	): Promise<void> {
		const temp = await this.nodeTempFile()
		try {
			await this.pull(vmid, containerPath, temp, options)
			await this.shell.download(temp, localPath)
		} finally {
			await this.removeNodeFile(temp)
		}
	}

	/** Filesystem usage of a running container's volumes, from `pct df`. */
	async df(vmid: number): Promise<readonly PctDiskUsage[]> {
		return parsePctDf(await this.shell.output(shJoin(['pct', 'df', vmidArg(vmid)])))
	}

	/** Mount a stopped container's filesystem on the node. It stays mounted until `unmount`. */
	mount(vmid: number, options: { timeoutMs?: number } = {}): Promise<CommandResult> {
		return this.run(['pct', 'mount', vmidArg(vmid)], options)
	}

	unmount(vmid: number, options: { timeoutMs?: number } = {}): Promise<CommandResult> {
		return this.run(['pct', 'unmount', vmidArg(vmid)], options)
	}

	/**
	 * Clear a stale config lock. Clearing a lock while the operation that set
	 * it is still running lets two writers touch the same config.
	 */
	unlock(vmid: number): Promise<CommandResult> {
		return this.run(['pct', 'unlock', vmidArg(vmid)])
	}

	/** Add volumes no config references back as unused mount points, and refresh disk sizes. */
	rescan(options: { vmid?: number; dryRun?: boolean } = {}): Promise<CommandResult> {
		const argv = ['pct', 'rescan']
		if (options.vmid !== undefined) argv.push('--vmid', vmidArg(options.vmid))
		if (options.dryRun) argv.push('--dryrun', '1')
		return this.run(argv)
	}

	/** Run a filesystem check on a stopped container's volume, repairing it in place. */
	fsck(
		vmid: number,
		options: { device?: string; force?: boolean; timeoutMs?: number } = {},
	): Promise<CommandResult> {
		const argv = ['pct', 'fsck', vmidArg(vmid)]
		if (options.force) argv.push('--force', '1')
		if (options.device !== undefined) argv.push('--device', options.device)
		return this.run(argv, options)
	}

	/** Discard unused blocks in the container's volumes. */
	fstrim(
		vmid: number,
		options: { ignoreMountpoints?: boolean; timeoutMs?: number } = {},
	): Promise<CommandResult> {
		const argv = ['pct', 'fstrim', vmidArg(vmid)]
		if (options.ignoreMountpoints) argv.push('--ignore-mountpoints', '1')
		return this.run(argv, options)
	}

	private run(
		argv: readonly string[],
		limits: { timeoutMs?: number } = {},
	): Promise<CommandResult> {
		const options: RunOptions = { check: true }
		if (limits.timeoutMs !== undefined) options.timeoutMs = limits.timeoutMs
		return this.shell.run(shJoin(argv), options)
	}

	private nodeTempFile(): Promise<string> {
		return this.shell.output('mktemp /tmp/pve-agent.XXXXXX')
	}

	private async removeNodeFile(path: string): Promise<void> {
		await this.shell.run(`rm -- ${shQuote(path)}`)
	}
}

function vmidArg(vmid: number): string {
	return String(assertSafeInteger(vmid, 'vmid'))
}

function transferFlags(options: PctTransferOptions): string[] {
	const flags: string[] = []
	if (options.perms !== undefined) flags.push('--perms', options.perms)
	if (options.user !== undefined) flags.push('--user', ownerArg(options.user, 'user'))
	if (options.group !== undefined) flags.push('--group', ownerArg(options.group, 'group'))
	return flags
}

function ownerArg(value: number | string, name: string): string {
	return typeof value === 'number' ? String(assertSafeInteger(value, name)) : value
}

/**
 * Parse the `pct list` table by the header's column offsets: the Lock column
 * is blank for most rows, so splitting on whitespace would shift the name
 * into it.
 */
export function parsePctList(output: string): readonly PctListEntry[] {
	const [header = '', ...lines] = output.split('\n')
	const columns = ['VMID', 'Status', 'Lock', 'Name'].map((title) => header.indexOf(title))
	if (columns.some((offset) => offset === -1)) return []
	const [vmidAt = 0, statusAt = 0, lockAt = 0, nameAt = 0] = columns
	const entries: PctListEntry[] = []
	for (const line of lines) {
		const vmid = line.slice(vmidAt, statusAt).trim()
		if (!/^\d+$/.test(vmid)) continue
		const lock = line.slice(lockAt, nameAt).trim()
		entries.push({
			vmid: Number(vmid),
			status: line.slice(statusAt, lockAt).trim(),
			lock: lock.length > 0 ? lock : undefined,
			name: line.slice(nameAt).trim(),
		})
	}
	return entries
}

/**
 * Parse the table `pct df` prints. Its columns are MP, Volume, Size, Used,
 * Avail, Use% and Path, with sizes in the K/M/G/T spelling.
 */
export function parsePctDf(output: string): readonly PctDiskUsage[] {
	const rows: PctDiskUsage[] = []
	for (const line of output.split('\n')) {
		const [mountPoint, volume, size, used, available, usePercent, ...path] = line
			.trim()
			.split(/\s+/)
		if (
			mountPoint === undefined ||
			mountPoint === 'MP' ||
			volume === undefined ||
			size === undefined ||
			used === undefined ||
			available === undefined ||
			usePercent === undefined ||
			path.length === 0
		) {
			continue
		}
		rows.push({
			mountPoint,
			volume,
			size,
			used,
			available,
			sizeBytes: parseSize(size),
			usedBytes: parseSize(used),
			availableBytes: parseSize(available),
			usePercent: Number.parseFloat(usePercent.replace('%', '')),
			path: path.join(' '),
		})
	}
	return rows
}

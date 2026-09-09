/**
 * The `qm` command line on the node.
 *
 * Importing a disk image or an OVF from a path on the node, the generated
 * KVM command line, rescanning storages, monitor commands, key events and
 * cleaning up after a crashed VM have no REST endpoint. The lifecycle calls
 * are here as well, for a caller that already holds a shell.
 */

import { isRecord } from '../core/values.ts'
import { PveShellOutputError } from './errors.ts'
import { assertSafeInteger, shJoin } from './escape.ts'
import type { NodeShell } from './node-shell.ts'
import type { CommandResult, RunOptions } from './types.ts'

export interface QmListEntry {
	vmid: number
	name: string
	status: string
	memoryMb: number
	bootDiskGb: number
	/** Undefined while the VM is stopped. */
	pid: number | undefined
}

export interface QmGuestExecResult {
	exitCode: number | undefined
	exited: boolean
	stdout: string
	stderr: string
	/** The agent capped the output it returned. */
	truncated: boolean
}

export interface ImportDiskOptions {
	/** Storage-specific format, such as 'raw' or 'qcow2'. */
	format?: string
	/** Attach the imported disk to this bus and index, such as 'scsi1'. */
	targetDisk?: string
	timeoutMs?: number
}

const DEFAULT_IMPORT_TIMEOUT_MS = 3_600_000

export class QmShell {
	private readonly shell: NodeShell

	constructor(shell: NodeShell) {
		this.shell = shell
	}

	/** Every VM on the node, from `qm list`. */
	async list(): Promise<readonly QmListEntry[]> {
		return parseQmList(await this.shell.output('qm list'))
	}

	/** The config as PVE writes it, including the lock and any pending changes. */
	async config(
		vmid: number,
		options: { current?: boolean; snapshot?: string } = {},
	): Promise<Record<string, string>> {
		const argv = ['qm', 'config', vmidArg(vmid)]
		if (options.current) argv.push('--current', '1')
		if (options.snapshot !== undefined) argv.push('--snapshot', options.snapshot)
		return parseGuestConfig(await this.shell.output(shJoin(argv)))
	}

	/** The run state, such as 'running' or 'stopped'. */
	async status(vmid: number): Promise<string> {
		const output = await this.shell.output(shJoin(['qm', 'status', vmidArg(vmid)]))
		return /status:\s*(\S+)/.exec(output)?.[1] ?? output
	}

	start(vmid: number, options: { timeoutMs?: number } = {}): Promise<CommandResult> {
		return this.run(['qm', 'start', vmidArg(vmid)], options)
	}

	/** Power the VM off. `timeoutSeconds` waits that long for the process to exit first. */
	stop(
		vmid: number,
		options: { timeoutSeconds?: number; overruleShutdown?: boolean; timeoutMs?: number } = {},
	): Promise<CommandResult> {
		const argv = ['qm', 'stop', vmidArg(vmid)]
		if (options.timeoutSeconds !== undefined) {
			argv.push('--timeout', String(assertSafeInteger(options.timeoutSeconds, 'timeoutSeconds')))
		}
		if (options.overruleShutdown) argv.push('--overrule-shutdown', '1')
		return this.run(argv, options)
	}

	/** Ask the guest to shut down, and with `forceStop` power it off when it has not by the timeout. */
	shutdown(
		vmid: number,
		options: { timeoutSeconds?: number; forceStop?: boolean; timeoutMs?: number } = {},
	): Promise<CommandResult> {
		const argv = ['qm', 'shutdown', vmidArg(vmid)]
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
		const argv = ['qm', 'reboot', vmidArg(vmid)]
		if (options.timeoutSeconds !== undefined) {
			argv.push('--timeout', String(assertSafeInteger(options.timeoutSeconds, 'timeoutSeconds')))
		}
		return this.run(argv, options)
	}

	/** Set config options, each as `--key value`. */
	set(vmid: number, settings: Readonly<Record<string, string | number>>): Promise<CommandResult> {
		const argv = ['qm', 'set', vmidArg(vmid)]
		for (const [key, value] of Object.entries(settings)) argv.push(`--${key}`, String(value))
		return this.run(argv)
	}

	/** Send a key event, in QEMU's key names such as 'ctrl-alt-delete'. */
	sendkey(vmid: number, key: string): Promise<CommandResult> {
		return this.run(['qm', 'sendkey', vmidArg(vmid), key])
	}

	/** Run one human monitor command and return what it printed. */
	async monitor(vmid: number, command: string): Promise<string> {
		const result = await this.shell.run(shJoin(['qm', 'monitor', vmidArg(vmid)]), {
			check: true,
			input: `${command}\n`,
		})
		return parseMonitorOutput(result.stdout)
	}

	/**
	 * Run a program inside the guest through the QEMU guest agent. The agent
	 * caps the output it returns; `timeoutSeconds` is how long qm waits for
	 * the program to exit.
	 */
	async guestExec(
		vmid: number,
		argv: readonly string[],
		options: { input?: string; timeoutSeconds?: number; timeoutMs?: number } = {},
	): Promise<QmGuestExecResult> {
		const command = ['qm', 'guest', 'exec', vmidArg(vmid)]
		if (options.input !== undefined) command.push('--pass-stdin', '1')
		if (options.timeoutSeconds !== undefined) {
			command.push('--timeout', String(assertSafeInteger(options.timeoutSeconds, 'timeoutSeconds')))
		}
		command.push('--', ...argv)
		const result = await this.run(command, options)
		return parseGuestExec(result.stdout)
	}

	/**
	 * Clear a stale config lock by rewriting the config without it. Clearing a
	 * lock while the operation that set it is still running lets two writers
	 * touch the same config.
	 */
	unlock(vmid: number): Promise<CommandResult> {
		return this.run(['qm', 'unlock', vmidArg(vmid)])
	}

	/**
	 * Import a disk image from a path on the node into a VM's storage. The
	 * API can only import a volume that already exists on a PVE storage. The
	 * whole image is copied, so give it a timeout that fits its size.
	 */
	importDisk(
		vmid: number,
		sourcePath: string,
		storage: string,
		options: ImportDiskOptions = {},
	): Promise<CommandResult> {
		const argv = ['qm', 'importdisk', vmidArg(vmid), sourcePath, storage]
		if (options.format !== undefined) argv.push('--format', options.format)
		if (options.targetDisk !== undefined) argv.push('--target-disk', options.targetDisk)
		return this.run(argv, { timeoutMs: options.timeoutMs ?? DEFAULT_IMPORT_TIMEOUT_MS })
	}

	/** Create a VM from an OVF manifest on the node. */
	importOvf(
		vmid: number,
		manifestPath: string,
		storage: string,
		options: { format?: string; timeoutMs?: number } = {},
	): Promise<CommandResult> {
		const argv = ['qm', 'importovf', vmidArg(vmid), manifestPath, storage]
		if (options.format !== undefined) argv.push('--format', options.format)
		return this.run(argv, { timeoutMs: options.timeoutMs ?? DEFAULT_IMPORT_TIMEOUT_MS })
	}

	/** The KVM command line PVE would build for a VM. */
	showCommand(
		vmid: number,
		options: { pretty?: boolean; snapshot?: string } = {},
	): Promise<string> {
		const argv = ['qm', 'showcmd', vmidArg(vmid)]
		if (options.pretty) argv.push('--pretty', '1')
		if (options.snapshot !== undefined) argv.push('--snapshot', options.snapshot)
		return this.shell.output(shJoin(argv))
	}

	/** Add volumes no config references back as unused disks, and refresh disk sizes. */
	rescan(options: { vmid?: number; dryRun?: boolean } = {}): Promise<CommandResult> {
		const argv = ['qm', 'rescan']
		if (options.vmid !== undefined) argv.push('--vmid', vmidArg(options.vmid))
		if (options.dryRun) argv.push('--dryrun', '1')
		return this.run(argv)
	}

	/** Stop an NBD export left behind by an interrupted migration. */
	nbdStop(vmid: number): Promise<CommandResult> {
		return this.run(['qm', 'nbdstop', vmidArg(vmid)])
	}

	/** Enrol the default Secure Boot keys into the EFI disk of a stopped VM. */
	enrollEfiKeys(vmid: number): Promise<CommandResult> {
		return this.run(['qm', 'enroll-efi-keys', vmidArg(vmid)])
	}

	/** Remove the runtime state of a VM whose process died, so PVE stops treating it as running. */
	cleanup(
		vmid: number,
		options: { keepActive?: boolean; cleanShutdown?: boolean } = {},
	): Promise<CommandResult> {
		return this.run([
			'qm',
			'cleanup',
			vmidArg(vmid),
			'--keep-active',
			options.keepActive ? '1' : '0',
			'--clean-shutdown',
			options.cleanShutdown ? '1' : '0',
		])
	}

	private run(
		argv: readonly string[],
		limits: { timeoutMs?: number; input?: string } = {},
	): Promise<CommandResult> {
		const options: RunOptions = { check: true }
		if (limits.timeoutMs !== undefined) options.timeoutMs = limits.timeoutMs
		if (limits.input !== undefined) options.input = limits.input
		return this.shell.run(shJoin(argv), options)
	}
}

function vmidArg(vmid: number): string {
	return String(assertSafeInteger(vmid, 'vmid'))
}

/**
 * Parse the `qm list` table. The name column is blank for a VM without one,
 * so the row is read from both ends: the vmid first, then the four trailing
 * columns, with whatever is left in between as the name.
 */
export function parseQmList(output: string): readonly QmListEntry[] {
	const entries: QmListEntry[] = []
	for (const line of output.split('\n')) {
		const parts = line.trim().split(/\s+/)
		if (parts.length < 5 || !/^\d+$/.test(parts[0] ?? '')) continue
		const [pid = '', bootDisk = '', memory = '', status = ''] = parts.slice(-4).reverse()
		entries.push({
			vmid: Number(parts[0]),
			name: parts.slice(1, -4).join(' '),
			status,
			memoryMb: Number(memory),
			bootDiskGb: Number(bootDisk),
			pid: pid === '0' ? undefined : Number(pid),
		})
	}
	return entries
}

/** Parse the `key: value` lines `qm config` and `pct config` print. */
export function parseGuestConfig(output: string): Record<string, string> {
	const config: Record<string, string> = {}
	for (const line of output.split('\n')) {
		const match = /^([a-z_][a-z0-9_-]*):\s*(.*)$/i.exec(line.trim())
		if (match?.[1] !== undefined) config[match[1]] = match[2] ?? ''
	}
	return config
}

/** Drop the banner `qm monitor` prints before the reply. */
export function parseMonitorOutput(stdout: string): string {
	const lines = stdout.replace(/\r/g, '').split('\n')
	if (lines[0]?.startsWith('Entering QEMU Monitor')) lines.shift()
	return lines.join('\n').trim()
}

/** Parse the JSON `qm guest exec` prints once the program has exited. */
export function parseGuestExec(stdout: string): QmGuestExecResult {
	let parsed: unknown
	try {
		parsed = JSON.parse(stdout)
	} catch (cause) {
		throw new PveShellOutputError({ what: 'qm guest exec printed no JSON', output: stdout, cause })
	}
	if (!isRecord(parsed)) {
		throw new PveShellOutputError({ what: 'qm guest exec printed no JSON object', output: stdout })
	}
	const record = parsed
	const exitCode = record['exitcode']
	return {
		exitCode: typeof exitCode === 'number' ? exitCode : undefined,
		exited: record['exited'] === 1 || record['exited'] === true,
		stdout: typeof record['out-data'] === 'string' ? record['out-data'] : '',
		stderr: typeof record['err-data'] === 'string' ? record['err-data'] : '',
		truncated: record['out-truncated'] === 1 || record['err-truncated'] === 1,
	}
}

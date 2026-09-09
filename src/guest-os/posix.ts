/**
 * The parts of the Linux and macOS helpers that are the same: `/bin/sh -c`
 * runs every command line, and files move as base64 so binary survives.
 */

import { shQuote } from '../shell/escape.ts'
import { checkResult } from './executor.ts'
import type {
	GuestExecutor,
	GuestOs,
	GuestOsInfo,
	GuestOsKind,
	GuestRunOptions,
	GuestRunResult,
} from './types.ts'

export interface PosixWriteFileOptions extends GuestRunOptions {
	/** Mode passed to chmod, such as '0644'. */
	mode?: string
	/** Write through `sudo -n`, which fails rather than asking for a password. */
	sudo?: boolean
}

export abstract class PosixGuest implements GuestOs {
	abstract readonly os: GuestOsKind
	readonly executor: GuestExecutor
	/** Flag that makes base64 decode: -d on GNU and busybox, -D on macOS. */
	private readonly base64Decode: string

	constructor(executor: GuestExecutor, base64Decode: string) {
		this.executor = executor
		this.base64Decode = base64Decode
	}

	get vmid(): number {
		return this.executor.vmid
	}

	abstract osInfo(options?: GuestRunOptions): Promise<GuestOsInfo>

	exec(argv: readonly string[], options: GuestRunOptions = {}): Promise<GuestRunResult> {
		return this.executor.exec(argv, options)
	}

	run(command: string, options: GuestRunOptions = {}): Promise<GuestRunResult> {
		return this.executor.exec(['/bin/sh', '-c', command], options)
	}

	sh(script: string, options: GuestRunOptions = {}): Promise<GuestRunResult> {
		return this.run(script, options)
	}

	async output(command: string, options: GuestRunOptions = {}): Promise<string> {
		const result = checkResult(this.vmid, command, await this.run(command, options), options)
		return result.stdout.trimEnd()
	}

	/** Run a command line as root through `sudo -n`, which fails rather than asking for a password. */
	sudo(command: string, options: GuestRunOptions = {}): Promise<GuestRunResult> {
		return this.executor.exec(['sudo', '-n', '/bin/sh', '-c', command], options)
	}

	async readFileBytes(path: string, options: GuestRunOptions = {}): Promise<Uint8Array> {
		const result = checkResult(
			this.vmid,
			`read ${path}`,
			await this.run(`base64 < ${shQuote(path)}`, options),
			options,
		)
		return new Uint8Array(Buffer.from(result.stdout.replace(/\s+/g, ''), 'base64'))
	}

	async readFile(path: string, options: GuestRunOptions = {}): Promise<string> {
		return new TextDecoder().decode(await this.readFileBytes(path, options))
	}

	async writeFile(
		path: string,
		content: string | Uint8Array,
		options: PosixWriteFileOptions = {},
	): Promise<void> {
		const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content)
		const prefix = options.sudo ? 'sudo -n ' : ''
		const line = `printf %s ${shQuote(bytes.toString('base64'))} | base64 ${this.base64Decode} | ${prefix}tee ${shQuote(path)} > /dev/null`
		checkResult(this.vmid, `write ${path}`, await this.run(line, options), options)
		if (options.mode !== undefined) {
			const chmod = `${prefix}chmod ${shQuote(options.mode)} ${shQuote(path)}`
			checkResult(this.vmid, `chmod ${path}`, await this.run(chmod, options), options)
		}
	}

	async delete(path: string, options: GuestRunOptions = {}): Promise<void> {
		checkResult(
			this.vmid,
			`delete ${path}`,
			await this.run(`rm -- ${shQuote(path)}`, options),
			options,
		)
	}

	async exists(path: string, options: GuestRunOptions = {}): Promise<boolean> {
		const result = await this.run(`test -e ${shQuote(path)}`, options)
		return result.exitCode === 0
	}

	async download(url: string, destination: string, options: GuestRunOptions = {}): Promise<void> {
		checkResult(
			this.vmid,
			`download ${url}`,
			await this.run(`curl -fLsS ${shQuote(url)} -o ${shQuote(destination)}`, options),
			options,
		)
	}

	hostname(options: GuestRunOptions = {}): Promise<string> {
		return this.output('hostname', options)
	}

	/** Restart the OS, trying `sudo -n` when a direct reboot is refused. */
	reboot(options: GuestRunOptions = {}): Promise<GuestRunResult> {
		return this.run('reboot 2>/dev/null || sudo -n reboot', options)
	}

	shutdown(options: GuestRunOptions = {}): Promise<GuestRunResult> {
		return this.run('shutdown -h now 2>/dev/null || sudo -n shutdown -h now', options)
	}
}

/**
 * Read `key<separator>value` lines into a record. A value wrapped in matching
 * single or double quotes loses them.
 */
export function parseFields(lines: readonly string[], separator: string): Record<string, string> {
	const fields: Record<string, string> = {}
	for (const line of lines) {
		const at = line.indexOf(separator)
		if (at <= 0) continue
		const key = line.slice(0, at).trim()
		const value = line.slice(at + separator.length).trim()
		fields[key] = /^(["']).*\1$/.test(value) ? value.slice(1, -1) : value
	}
	return fields
}

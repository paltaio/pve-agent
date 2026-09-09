/**
 * Windows guest helpers.
 *
 * A command line runs through `cmd.exe /c`; a script runs through Windows
 * PowerShell as `-EncodedCommand`, a UTF-16 base64 blob, so quotes, pipes
 * and newlines arrive untouched and nothing is quoted twice for cmd and
 * PowerShell in turn. A value that sits inside a PowerShell string literal is
 * single-quoted with `psQuote`, which is the only escaping PowerShell needs
 * there.
 */

import { isRecord } from '../core/values.ts'
import { checkResult } from './executor.ts'
import type {
	GuestExecutor,
	GuestOs,
	GuestOsInfo,
	GuestRunOptions,
	GuestRunResult,
} from './types.ts'

const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const CMD = 'C:\\Windows\\System32\\cmd.exe'

/** Escape a value for a single-quoted PowerShell string literal. */
export function psQuote(value: string): string {
	return value.replace(/'/g, "''")
}

/** Encode a script for `powershell.exe -EncodedCommand`. */
export function psEncode(script: string): string {
	return Buffer.from(script, 'utf16le').toString('base64')
}

function psString(value: string): string {
	return `'${psQuote(value)}'`
}

export class WindowsGuest implements GuestOs {
	readonly os = 'windows' as const
	readonly executor: GuestExecutor

	constructor(executor: GuestExecutor) {
		this.executor = executor
	}

	get vmid(): number {
		return this.executor.vmid
	}

	exec(argv: readonly string[], options: GuestRunOptions = {}): Promise<GuestRunResult> {
		return this.executor.exec(argv, options)
	}

	/** Run one `cmd.exe /c` line. The line is handed to cmd as is. */
	cmd(line: string, options: GuestRunOptions = {}): Promise<GuestRunResult> {
		return this.executor.exec([CMD, '/c', line], options)
	}

	/** Run a PowerShell script, which may span lines. */
	powershell(script: string, options: GuestRunOptions = {}): Promise<GuestRunResult> {
		return this.executor.exec(
			[
				POWERSHELL,
				'-NoProfile',
				'-NonInteractive',
				'-ExecutionPolicy',
				'Bypass',
				'-EncodedCommand',
				psEncode(script),
			],
			options,
		)
	}

	run(command: string, options: GuestRunOptions = {}): Promise<GuestRunResult> {
		return this.cmd(command, options)
	}

	sh(script: string, options: GuestRunOptions = {}): Promise<GuestRunResult> {
		return this.powershell(script, options)
	}

	async output(command: string, options: GuestRunOptions = {}): Promise<string> {
		const result = checkResult(this.vmid, command, await this.cmd(command, options), options)
		return result.stdout.trimEnd()
	}

	async readFileBytes(path: string, options: GuestRunOptions = {}): Promise<Uint8Array> {
		const encoded = await this.psOutput(
			`[Convert]::ToBase64String([IO.File]::ReadAllBytes(${psString(path)}))`,
			`read ${path}`,
			options,
		)
		return new Uint8Array(Buffer.from(encoded.replace(/\s+/g, ''), 'base64'))
	}

	/** Read a text file, dropping the byte order mark Windows tools often write first. */
	async readFile(path: string, options: GuestRunOptions = {}): Promise<string> {
		const text = new TextDecoder().decode(await this.readFileBytes(path, options))
		return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
	}

	async writeFile(
		path: string,
		content: string | Uint8Array,
		options: GuestRunOptions = {},
	): Promise<void> {
		const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content)
		await this.psOutput(
			`[IO.File]::WriteAllBytes(${psString(path)}, [Convert]::FromBase64String('${bytes.toString('base64')}'))`,
			`write ${path}`,
			options,
		)
	}

	async delete(path: string, options: GuestRunOptions = {}): Promise<void> {
		await this.psOutput(
			`Remove-Item -LiteralPath ${psString(path)} -Force`,
			`delete ${path}`,
			options,
		)
	}

	async exists(path: string, options: GuestRunOptions = {}): Promise<boolean> {
		const result = await this.powershell(
			`if (Test-Path -LiteralPath ${psString(path)}) { exit 0 } else { exit 1 }`,
			options,
		)
		return result.exitCode === 0
	}

	async download(url: string, destination: string, options: GuestRunOptions = {}): Promise<void> {
		await this.psOutput(
			[
				"$ProgressPreference = 'SilentlyContinue'",
				`Invoke-WebRequest -UseBasicParsing -Uri ${psString(url)} -OutFile ${psString(destination)}`,
			].join('; '),
			`download ${url}`,
			options,
		)
	}

	hostname(options: GuestRunOptions = {}): Promise<string> {
		return this.psOutput('$env:COMPUTERNAME', 'read the computer name', options)
	}

	/** What Win32_OperatingSystem reports. `kernel` carries the full version number, such as 10.0.19045. */
	async osInfo(options: GuestRunOptions = {}): Promise<GuestOsInfo> {
		const json = await this.psOutput(
			[
				'$o = Get-CimInstance Win32_OperatingSystem',
				'@{ Caption = $o.Caption; Version = $o.Version; BuildNumber = $o.BuildNumber; Architecture = $env:PROCESSOR_ARCHITECTURE } | ConvertTo-Json -Compress',
			].join('; '),
			'read the OS version',
			options,
		)
		const parsed: unknown = JSON.parse(json)
		const raw: Record<string, string> = {}
		if (isRecord(parsed)) {
			for (const [key, value] of Object.entries(parsed)) {
				raw[key] = value === null || value === undefined ? '' : String(value).trim()
			}
		}
		const caption = raw['Caption'] ?? ''
		return {
			os: 'windows',
			id: 'windows',
			name: caption,
			version: raw['Version'] ?? '',
			prettyName: caption,
			kernel: raw['Version'] ?? '',
			arch: raw['Architecture'] ?? '',
			raw,
		}
	}

	reboot(options: GuestRunOptions = {}): Promise<GuestRunResult> {
		return this.cmd('shutdown /r /t 0 /f', options)
	}

	shutdown(options: GuestRunOptions = {}): Promise<GuestRunResult> {
		return this.cmd('shutdown /s /t 0 /f', options)
	}

	/** Run a script that stops at its first error and return its trimmed stdout. */
	private async psOutput(script: string, what: string, options: GuestRunOptions): Promise<string> {
		const result = checkResult(
			this.vmid,
			what,
			await this.powershell(`$ErrorActionPreference = 'Stop'; ${script}`, options),
			options,
		)
		return result.stdout.trim()
	}
}

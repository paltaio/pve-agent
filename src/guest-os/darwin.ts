/**
 * macOS guest helpers. base64 decodes with -D, and AppleScript drives
 * anything that lives on the logged-in user's desktop.
 */

import { shQuote } from '../shell/escape.ts'
import { checkResult } from './executor.ts'
import { parseFields, PosixGuest } from './posix.ts'
import type { GuestExecutor, GuestOsInfo, GuestRunOptions, GuestRunResult } from './types.ts'

export class DarwinGuest extends PosixGuest {
	readonly os = 'darwin' as const

	constructor(executor: GuestExecutor) {
		super(executor, '-D')
	}

	/** Evaluate an AppleScript, passed as one argument. */
	osascript(script: string, options: GuestRunOptions = {}): Promise<GuestRunResult> {
		return this.executor.exec(['/usr/bin/osascript', '-e', script], options)
	}

	/** Put text on the clipboard of the logged-in user. */
	async setClipboard(text: string, options: GuestRunOptions = {}): Promise<void> {
		const encoded = Buffer.from(text, 'utf8').toString('base64')
		checkResult(
			this.vmid,
			'set the clipboard',
			await this.run(`printf %s ${shQuote(encoded)} | base64 -D | pbcopy`, options),
			options,
		)
	}

	/** The kernel, the machine type and what `sw_vers` reports. */
	async osInfo(options: GuestRunOptions = {}): Promise<GuestOsInfo> {
		const [kernel = '', arch = '', ...versions] = (
			await this.output('uname -r; uname -m; sw_vers', options)
		).split('\n')
		const raw = parseFields(versions, ':')
		const name = raw['ProductName'] ?? ''
		const version = raw['ProductVersion'] ?? ''
		return {
			os: 'darwin',
			id: 'macos',
			name,
			version,
			prettyName: `${name} ${version}`.trim(),
			kernel,
			arch,
			raw,
		}
	}
}

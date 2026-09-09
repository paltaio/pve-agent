/**
 * Linux guest helpers. The same class serves a VM reached through the guest
 * agent and a container reached through `pct exec`.
 */

import { shJoin } from '../shell/escape.ts'
import { parseFields, PosixGuest } from './posix.ts'
import type { GuestExecutor, GuestOsInfo, GuestRunOptions, GuestRunResult } from './types.ts'

export class LinuxGuest extends PosixGuest {
	readonly os = 'linux' as const

	constructor(executor: GuestExecutor) {
		super(executor, '-d')
	}

	systemctl(args: readonly string[], options: GuestRunOptions = {}): Promise<GuestRunResult> {
		return this.run(`systemctl ${shJoin(args)}`, options)
	}

	/** The kernel, the machine type and every field of /etc/os-release. */
	async osInfo(options: GuestRunOptions = {}): Promise<GuestOsInfo> {
		const [kernel = '', arch = '', ...release] = (
			await this.output('uname -r; uname -m; cat /etc/os-release', options)
		).split('\n')
		const raw = parseFields(release, '=')
		return {
			os: 'linux',
			id: raw['ID'] ?? '',
			name: raw['NAME'] ?? '',
			version: raw['VERSION_ID'] ?? '',
			prettyName: raw['PRETTY_NAME'] ?? '',
			kernel,
			arch,
			raw,
		}
	}
}

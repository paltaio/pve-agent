/**
 * Packages on the node.
 *
 * The API reports what an update would bring and can run apt-get update and
 * a dist-upgrade as a task. Installing a named package, removing one, holds,
 * cache queries, repository files and keyrings go through the shell.
 *
 * Every apt call runs non-interactively and keeps the installed version of a
 * conffile when the package ships a changed one: a prompt on a node with no
 * terminal never gets answered.
 */

import { assertPathSegment, shHeredoc, shJoin, shQuote } from './escape.ts'
import type { NodeShell } from './node-shell.ts'
import type { CommandResult, RunOptions } from './types.ts'

export interface AptUpgradable {
	name: string
	/** The suite the candidate comes from, such as 'stable' or 'trixie-security'. */
	suite: string
	currentVersion: string
	newVersion: string
	architecture: string
}

export interface AptChange {
	action: 'install' | 'upgrade' | 'remove'
	name: string
	/** Version installed now, for an upgrade or a removal. */
	currentVersion: string | undefined
	/** Version apt would move to. */
	newVersion: string | undefined
	architecture: string | undefined
}

export interface AptPolicy {
	/** Undefined when the package is not installed. */
	installed: string | undefined
	/** Undefined when no source offers the package. */
	candidate: string | undefined
	versions: readonly { version: string; priority: number }[]
}

export interface AptSearchHit {
	name: string
	description: string
}

export interface InstalledPackage {
	name: string
	version: string
	/** dpkg status field, such as 'install ok installed'. */
	status: string
}

const APT_GET = [
	'apt-get',
	'-y',
	'-o',
	'Dpkg::Options::=--force-confdef',
	'-o',
	'Dpkg::Options::=--force-confold',
]
const APT_ENV = { DEBIAN_FRONTEND: 'noninteractive' }
const DEFAULT_APT_TIMEOUT_MS = 900_000

export class AptShell {
	private readonly shell: NodeShell

	constructor(shell: NodeShell) {
		this.shell = shell
	}

	/** Refresh the package lists. */
	update(options: { timeoutMs?: number } = {}): Promise<CommandResult> {
		return this.aptGet(['update'], options)
	}

	/** Installed packages with a newer candidate, from `apt list --upgradable`. */
	async listUpgradable(): Promise<readonly AptUpgradable[]> {
		const output = await this.shell.output('apt list --upgradable 2>/dev/null', {
			env: { LC_ALL: 'C' },
		})
		return parseAptList(output)
	}

	/**
	 * What a dist-upgrade would change, from an apt simulation that installs
	 * nothing. Unlike `listUpgradable`, this includes the packages a
	 * dependency change would add or remove.
	 */
	async pendingUpgrades(): Promise<readonly AptChange[]> {
		const output = await this.shell.output('apt-get -s dist-upgrade', {
			env: { LC_ALL: 'C' },
			timeoutMs: 120_000,
		})
		return parseAptSimulation(output)
	}

	/** Install packages. apt may remove a conflicting package to satisfy the request. */
	install(
		packages: readonly string[],
		options: { recommends?: boolean; timeoutMs?: number } = {},
	): Promise<CommandResult> {
		const flags = options.recommends === false ? ['--no-install-recommends'] : []
		return this.aptGet([...flags, 'install', ...packages], options)
	}

	/** Upgrade installed packages without adding or removing any. */
	upgrade(options: { timeoutMs?: number } = {}): Promise<CommandResult> {
		return this.aptGet(['upgrade'], options)
	}

	/** Upgrade with dependency changes allowed, which a PVE release update needs. */
	distUpgrade(options: { timeoutMs?: number } = {}): Promise<CommandResult> {
		return this.aptGet(['dist-upgrade'], options)
	}

	/** Remove packages, keeping their configuration files. */
	remove(
		packages: readonly string[],
		options: { timeoutMs?: number } = {},
	): Promise<CommandResult> {
		return this.aptGet(['remove', ...packages], options)
	}

	/** Remove packages and their configuration files. */
	purge(packages: readonly string[], options: { timeoutMs?: number } = {}): Promise<CommandResult> {
		return this.aptGet(['purge', ...packages], options)
	}

	/** Remove packages that were installed as dependencies and are no longer needed. */
	autoremove(options: { purge?: boolean; timeoutMs?: number } = {}): Promise<CommandResult> {
		return this.aptGet(['autoremove', ...(options.purge ? ['--purge'] : [])], options)
	}

	/** Installed and candidate versions with the version table, from `apt-cache policy`. */
	async policy(name: string): Promise<AptPolicy> {
		const output = await this.shell.output(shJoin(['apt-cache', 'policy', name]), {
			env: { LC_ALL: 'C' },
		})
		return parseAptPolicy(output)
	}

	/** Package records from `apt-cache show`, one per available version, newest first. */
	async show(name: string): Promise<readonly Record<string, string>[]> {
		const output = await this.shell.output(shJoin(['apt-cache', 'show', name]), {
			env: { LC_ALL: 'C' },
		})
		return parseStanzas(output)
	}

	/** Packages whose name or description matches a regular expression. */
	async search(
		pattern: string,
		options: { namesOnly?: boolean } = {},
	): Promise<readonly AptSearchHit[]> {
		const argv = ['apt-cache', 'search']
		if (options.namesOnly) argv.push('--names-only')
		argv.push('--', pattern)
		const output = await this.shell.output(shJoin(argv), { env: { LC_ALL: 'C' } })
		return output
			.split('\n')
			.filter((line) => line.length > 0)
			.map((line) => {
				const index = line.indexOf(' - ')
				return index === -1
					? { name: line, description: '' }
					: { name: line.slice(0, index), description: line.slice(index + 3) }
			})
	}

	/** Keep packages at their installed version through upgrades. */
	hold(packages: readonly string[]): Promise<CommandResult> {
		return this.shell.run(shJoin(['apt-mark', 'hold', ...packages]), { check: true })
	}

	unhold(packages: readonly string[]): Promise<CommandResult> {
		return this.shell.run(shJoin(['apt-mark', 'unhold', ...packages]), { check: true })
	}

	/** Packages currently on hold. */
	async listHolds(): Promise<readonly string[]> {
		const output = await this.shell.output('apt-mark showhold')
		return output.split('\n').filter((line) => line.length > 0)
	}

	/** The installed version of a package, or undefined when it is not installed. */
	async installedVersion(name: string): Promise<string | undefined> {
		const result = await this.shell.run(
			`${shJoin(['dpkg-query', '-W', '-f', '${Version}', name])} 2>/dev/null`,
		)
		const version = result.stdout.trim()
		return result.exitCode === 0 && version.length > 0 ? version : undefined
	}

	/** Installed packages, narrowed by a dpkg glob when one is given. */
	async listInstalled(pattern?: string): Promise<readonly InstalledPackage[]> {
		const argv = ['dpkg-query', '-W', '-f', '${Package}\\t${Version}\\t${Status}\\n']
		if (pattern !== undefined) argv.push(pattern)
		const output = await this.shell.output(shJoin(argv))
		return output
			.split('\n')
			.filter((line) => line.length > 0)
			.map((line) => {
				const [name, version, status] = line.split('\t')
				return { name: name ?? '', version: version ?? '', status: status ?? '' }
			})
	}

	/** Write an apt source file under /etc/apt/sources.list.d, replacing it when it exists. */
	async addRepository(fileName: string, content: string): Promise<string> {
		const path = `/etc/apt/sources.list.d/${assertPathSegment(fileName, 'fileName')}`
		await this.shell.run(`cat > ${shQuote(path)} ${shHeredoc(content)}`, { check: true })
		return path
	}

	/** Write a repository signing key under /etc/apt/keyrings, replacing it when it exists. */
	async addKeyring(fileName: string, key: Uint8Array | string): Promise<string> {
		const path = `/etc/apt/keyrings/${assertPathSegment(fileName, 'fileName')}`
		const bytes = typeof key === 'string' ? new TextEncoder().encode(key) : key
		const encoded = Buffer.from(bytes).toString('base64')
		await this.shell.run(
			`mkdir -p /etc/apt/keyrings && printf %s ${shQuote(encoded)} | base64 -d > ${shQuote(path)}`,
			{ check: true },
		)
		return path
	}

	private aptGet(argv: readonly string[], limits: { timeoutMs?: number }): Promise<CommandResult> {
		const options: RunOptions = {
			check: true,
			env: APT_ENV,
			timeoutMs: limits.timeoutMs ?? DEFAULT_APT_TIMEOUT_MS,
		}
		return this.shell.run(shJoin([...APT_GET, ...argv]), options)
	}
}

/**
 * Parse `apt list --upgradable`: after a 'Listing...' line, one row per
 * package in the form `name/suite version arch [upgradable from: old]`.
 */
export function parseAptList(output: string): readonly AptUpgradable[] {
	const rows: AptUpgradable[] = []
	for (const line of output.split('\n')) {
		const match = /^([^/\s]+)\/(\S+)\s+(\S+)\s+(\S+)\s+\[upgradable from:\s*([^\]]+)\]/.exec(line)
		if (match?.[1] === undefined) continue
		rows.push({
			name: match[1],
			suite: match[2] ?? '',
			newVersion: match[3] ?? '',
			architecture: match[4] ?? '',
			currentVersion: match[5]?.trim() ?? '',
		})
	}
	return rows
}

/**
 * Parse the Inst and Remv lines of `apt-get -s`. The format is
 * `Inst name [old] (new source [arch])`, with the bracketed old version absent
 * for a new install.
 */
export function parseAptSimulation(output: string): readonly AptChange[] {
	const changes: AptChange[] = []
	for (const line of output.split('\n')) {
		const trimmed = line.trim()
		if (trimmed.startsWith('Remv ')) {
			const match = /^Remv\s+(\S+)(?:\s+\[([^\]]+)\])?/.exec(trimmed)
			if (match?.[1] !== undefined) {
				changes.push({
					action: 'remove',
					name: match[1],
					currentVersion: match[2],
					newVersion: undefined,
					architecture: undefined,
				})
			}
			continue
		}
		if (!trimmed.startsWith('Inst ')) continue
		const match = /^Inst\s+(\S+)(?:\s+\[([^\]]+)\])?\s+\(([^\s)]+)([^)]*)\)/.exec(trimmed)
		if (match?.[1] === undefined) continue
		changes.push({
			action: match[2] === undefined ? 'install' : 'upgrade',
			name: match[1],
			currentVersion: match[2],
			newVersion: match[3],
			architecture: /\[([^\]]+)\]\s*$/.exec(match[4] ?? '')?.[1],
		})
	}
	return changes
}

/** Parse `apt-cache policy` for one package. */
export function parseAptPolicy(output: string): AptPolicy {
	const versions: { version: string; priority: number }[] = []
	let installed: string | undefined
	let candidate: string | undefined
	for (const line of output.split('\n')) {
		const field = /^\s*(Installed|Candidate):\s*(.*)$/.exec(line)
		if (field?.[1] !== undefined) {
			const value = field[2] === '(none)' ? undefined : field[2]
			if (field[1] === 'Installed') installed = value
			else candidate = value
			continue
		}
		const entry = /^\s*(?:\*\*\*\s+)?(\S+)\s+(-?\d+)\s*$/.exec(line)
		if (entry?.[1] !== undefined) {
			versions.push({ version: entry[1], priority: Number(entry[2]) })
		}
	}
	return { installed, candidate, versions }
}

/** Split RFC 822 style stanzas: blank lines separate records, an indented line continues a field. */
export function parseStanzas(output: string): readonly Record<string, string>[] {
	const stanzas: Record<string, string>[] = []
	let current: Record<string, string> = {}
	let lastKey: string | undefined
	for (const line of output.split('\n')) {
		if (line.trim().length === 0) {
			if (Object.keys(current).length > 0) stanzas.push(current)
			current = {}
			lastKey = undefined
			continue
		}
		if (/^\s/.test(line) && lastKey !== undefined) {
			current[lastKey] = `${current[lastKey] ?? ''}\n${line.trim()}`
			continue
		}
		const index = line.indexOf(':')
		if (index <= 0) continue
		lastKey = line.slice(0, index)
		current[lastKey] = line.slice(index + 1).trim()
	}
	if (Object.keys(current).length > 0) stanzas.push(current)
	return stanzas
}

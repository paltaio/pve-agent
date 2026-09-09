/**
 * systemd units on the node.
 *
 * The node API's service endpoint takes a fixed list of PVE units. Any other
 * unit, and every unit file, drop-in, timer and mask, goes through the shell.
 * `systemctl show` is the query: its Key=Value output parses without guessing
 * at column widths.
 */

import { assertPathSegment, assertSafeInteger, shHeredoc, shJoin, shQuote } from './escape.ts'
import type { NodeShell } from './node-shell.ts'
import type { CommandResult, RunOptions } from './types.ts'

export interface SystemdUnitRow {
	unit: string
	load: string
	active: string
	sub: string
	description: string
}

export interface SystemdUnitStatus {
	id: string
	description: string
	loadState: string
	activeState: string
	subState: string
	/** 'enabled', 'disabled', 'masked', 'static', or empty for a transient unit. */
	unitFileState: string
	fragmentPath: string
	mainPid: number
	restarts: number
	result: string
}

export interface SystemdTimer {
	unit: string
	service: string
	/** Microseconds since the epoch, or undefined when the timer has no next run. */
	nextElapseUsec: number | undefined
	lastTriggerUsec: number | undefined
}

export interface JournalOptions {
	unit?: string
	/** Defaults to 100. */
	lines?: number
	/** A journalctl time spec, such as '-1h' or '2026-09-01 12:00'. */
	since?: string
	/** A syslog priority or range, such as 'err' or 'warning..emerg'. */
	priority?: string
}

const STATUS_PROPERTIES = [
	'Id',
	'Description',
	'LoadState',
	'ActiveState',
	'SubState',
	'UnitFileState',
	'FragmentPath',
	'MainPID',
	'NRestarts',
	'Result',
]

const UNIT_DIRECTORY = '/etc/systemd/system'

export class SystemdShell {
	private readonly shell: NodeShell

	constructor(shell: NodeShell) {
		this.shell = shell
	}

	/** Units systemd knows about, one row per unit. */
	async listUnits(
		options: { type?: string; state?: string; pattern?: string } = {},
	): Promise<readonly SystemdUnitRow[]> {
		const argv = ['systemctl', 'list-units', '--all', '--plain', '--no-legend', '--no-pager']
		if (options.type !== undefined) argv.push(`--type=${options.type}`)
		if (options.state !== undefined) argv.push(`--state=${options.state}`)
		if (options.pattern !== undefined) argv.push(options.pattern)
		const output = await this.shell.output(shJoin(argv))
		return output
			.split('\n')
			.map((line) => line.trim())
			.filter((line) => line.length > 0)
			.map((line) => {
				const [unit, load, active, sub, ...description] = line.split(/\s+/)
				return {
					unit: unit ?? '',
					load: load ?? '',
					active: active ?? '',
					sub: sub ?? '',
					description: description.join(' '),
				}
			})
	}

	/** Raw `systemctl show` properties for one unit. */
	async show(unit: string, properties?: readonly string[]): Promise<Record<string, string>> {
		const argv = ['systemctl', 'show', unit]
		if (properties !== undefined && properties.length > 0) {
			argv.push(`--property=${properties.join(',')}`)
		}
		return parseShowBlock(await this.shell.output(shJoin(argv)))
	}

	/** `systemctl show` for several units in one call. */
	async showMany(
		units: readonly string[],
		properties: readonly string[],
	): Promise<readonly Record<string, string>[]> {
		if (units.length === 0) return []
		const output = await this.shell.output(
			shJoin(['systemctl', 'show', ...units, `--property=${properties.join(',')}`]),
		)
		return output
			.split(/\n{2,}/)
			.map((block) => parseShowBlock(block))
			.filter((block) => Object.keys(block).length > 0)
	}

	/** The load, active and enablement state of one unit. */
	async status(unit: string): Promise<SystemdUnitStatus> {
		const properties = await this.show(unit, STATUS_PROPERTIES)
		return {
			id: properties['Id'] ?? '',
			description: properties['Description'] ?? '',
			loadState: properties['LoadState'] ?? '',
			activeState: properties['ActiveState'] ?? '',
			subState: properties['SubState'] ?? '',
			unitFileState: properties['UnitFileState'] ?? '',
			fragmentPath: properties['FragmentPath'] ?? '',
			mainPid: Number(properties['MainPID'] ?? 0),
			restarts: Number(properties['NRestarts'] ?? 0),
			result: properties['Result'] ?? '',
		}
	}

	/** Whether a unit is running. */
	async isActive(unit: string): Promise<boolean> {
		const result = await this.shell.run(shJoin(['systemctl', 'is-active', unit]))
		return result.stdout.trim() === 'active'
	}

	/** Whether a unit starts at boot. */
	async isEnabled(unit: string): Promise<boolean> {
		const result = await this.shell.run(shJoin(['systemctl', 'is-enabled', unit]))
		return result.stdout.trim() === 'enabled'
	}

	/** Timers with their next and last trigger times. */
	async listTimers(): Promise<readonly SystemdTimer[]> {
		const rows = await this.listUnits({ type: 'timer' })
		const blocks = await this.showMany(
			rows.map((row) => row.unit),
			['Id', 'Unit', 'NextElapseUSecRealtime', 'LastTriggerUSec'],
		)
		return blocks.map((block) => ({
			unit: block['Id'] ?? '',
			service: block['Unit'] ?? '',
			nextElapseUsec: microseconds(block['NextElapseUSecRealtime']),
			lastTriggerUsec: microseconds(block['LastTriggerUSec']),
		}))
	}

	start(unit: string, options: { timeoutMs?: number } = {}): Promise<CommandResult> {
		return this.systemctl(['start', unit], options)
	}

	stop(unit: string, options: { timeoutMs?: number } = {}): Promise<CommandResult> {
		return this.systemctl(['stop', unit], options)
	}

	restart(unit: string, options: { timeoutMs?: number } = {}): Promise<CommandResult> {
		return this.systemctl(['restart', unit], options)
	}

	/** Reload a unit's configuration without restarting it. */
	reload(unit: string, options: { timeoutMs?: number } = {}): Promise<CommandResult> {
		return this.systemctl(['reload', unit], options)
	}

	/** Start a unit at boot, and with `now` start it at once. */
	enable(
		unit: string,
		options: { now?: boolean; timeoutMs?: number } = {},
	): Promise<CommandResult> {
		return this.systemctl(['enable', ...(options.now ? ['--now'] : []), unit], options)
	}

	/** Stop a unit from starting at boot, and with `now` stop it at once. */
	disable(
		unit: string,
		options: { now?: boolean; timeoutMs?: number } = {},
	): Promise<CommandResult> {
		return this.systemctl(['disable', ...(options.now ? ['--now'] : []), unit], options)
	}

	/**
	 * Mask a unit, which stops anything from starting it, a dependency
	 * included. A masked PVE unit breaks the node until it is unmasked.
	 */
	mask(unit: string, options: { now?: boolean; timeoutMs?: number } = {}): Promise<CommandResult> {
		return this.systemctl(['mask', ...(options.now ? ['--now'] : []), unit], options)
	}

	unmask(unit: string, options: { timeoutMs?: number } = {}): Promise<CommandResult> {
		return this.systemctl(['unmask', unit], options)
	}

	/** Re-read unit files after one is written or removed. */
	daemonReload(options: { timeoutMs?: number } = {}): Promise<CommandResult> {
		return this.systemctl(['daemon-reload'], options)
	}

	/**
	 * Write a unit file, or a drop-in for an existing unit, and reload
	 * systemd. With `dropIn` the content lands in
	 * /etc/systemd/system/<unit>.d/<dropIn>.conf and only overrides the
	 * settings it names. Returns the path written.
	 */
	async writeUnit(
		unit: string,
		content: string,
		options: { dropIn?: string; reload?: boolean } = {},
	): Promise<string> {
		const path = unitPath(unit, options.dropIn)
		const directory = path.slice(0, path.lastIndexOf('/'))
		const [operator = '', ...body] = shHeredoc(content).split('\n')
		const command =
			`mkdir -p -- ${shQuote(directory)} && cat > ${shQuote(path)} ${operator} && ` +
			`chmod 0644 -- ${shQuote(path)}\n${body.join('\n')}`
		await this.shell.run(command, { check: true })
		if (options.reload !== false) await this.daemonReload()
		return path
	}

	/** Read a unit file or drop-in back. */
	readUnit(unit: string, options: { dropIn?: string } = {}): Promise<string> {
		return this.shell.output(shJoin(['cat', '--', unitPath(unit, options.dropIn)]))
	}

	/** Delete a unit file or drop-in and reload systemd. */
	async removeUnit(
		unit: string,
		options: { dropIn?: string; reload?: boolean } = {},
	): Promise<void> {
		await this.shell.run(shJoin(['rm', '--', unitPath(unit, options.dropIn)]), { check: true })
		if (options.reload !== false) await this.daemonReload()
	}

	/** The most recent journal lines, newest last. */
	async journal(options: JournalOptions = {}): Promise<readonly string[]> {
		const argv = ['journalctl', '-q', '--no-pager']
		argv.push('-n', String(assertSafeInteger(options.lines ?? 100, 'lines')))
		if (options.unit !== undefined) argv.push('-u', options.unit)
		if (options.since !== undefined) argv.push('--since', options.since)
		if (options.priority !== undefined) argv.push('-p', options.priority)
		const output = await this.shell.output(shJoin(argv))
		return output.length === 0 ? [] : output.split('\n')
	}

	private systemctl(
		argv: readonly string[],
		limits: { timeoutMs?: number },
	): Promise<CommandResult> {
		const options: RunOptions = { check: true }
		if (limits.timeoutMs !== undefined) options.timeoutMs = limits.timeoutMs
		return this.shell.run(shJoin(['systemctl', ...argv]), options)
	}
}

/** Both names are one path component, so the file stays under UNIT_DIRECTORY. */
function unitPath(unit: string, dropIn: string | undefined): string {
	const name = assertPathSegment(unit, 'unit')
	return dropIn === undefined
		? `${UNIT_DIRECTORY}/${name}`
		: `${UNIT_DIRECTORY}/${name}.d/${assertPathSegment(dropIn, 'dropIn')}.conf`
}

/** Parse the Key=Value block `systemctl show` prints. */
export function parseShowBlock(output: string): Record<string, string> {
	const properties: Record<string, string> = {}
	for (const line of output.split('\n')) {
		const index = line.indexOf('=')
		if (index <= 0) continue
		properties[line.slice(0, index)] = line.slice(index + 1)
	}
	return properties
}

/** systemd reports 'never' as the maximum unsigned 64-bit value and 'unset' as 0. */
function microseconds(value: string | undefined): number | undefined {
	if (value === undefined || value === '') return undefined
	const parsed = Number(value)
	if (!Number.isFinite(parsed) || parsed === 0) return undefined
	return parsed >= Number.MAX_SAFE_INTEGER ? undefined : parsed
}

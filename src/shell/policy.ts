/**
 * The check a shell runs on each command line before it goes to the node.
 *
 * A policy is a deny list, an optional allow list, and the built-in patterns
 * for commands that destroy data. It reads the line as text: it is a rail
 * against a plausible mistake, not a sandbox.
 */

import { PveShellPolicyError } from './errors.ts'
import type { ShellPattern, ShellPolicy } from './types.ts'

export interface DestructivePattern {
	/**
	 * Tested against each command of the line on its own, written as the
	 * program's base name followed by its arguments with quotes removed and
	 * wrappers such as sudo, env and timeout stripped.
	 */
	pattern: RegExp
	reason: string
}

const POWER_TARGET = /\b(reboot|poweroff|halt|kexec|emergency|rescue)\.target\b/

/** Commands the default policy refuses. */
export const DESTRUCTIVE_PATTERNS: readonly DestructivePattern[] = [
	{
		pattern:
			/(?:^|\s)rm\s(?:.*\s)?(?:-[A-Za-z]*[rRf]|--recursive|--force|--no-preserve-root)(?=\s|$)/,
		reason: 'rm with -r or -f',
	},
	{ pattern: /\bshred\b/, reason: 'shred overwrites file contents' },
	{ pattern: /\bfind\b.*\s-delete\b/, reason: 'find -delete' },
	{
		pattern: /\bzpool\s+(destroy|labelclear|split|remove|detach|offline|replace)\b/,
		reason: 'zpool state change',
	},
	{
		pattern: /\bzfs\s+(destroy|rollback|change-key)\b/,
		reason: 'zfs destroy, rollback or key change',
	},
	{ pattern: /\bmkfs(\.[a-z0-9]+)?\b|\bmke2fs\b/, reason: 'filesystem creation' },
	{
		pattern: /\bwipefs\b|\bblkdiscard\b|\bsgdisk\b|\bfdisk\b|\bparted\b|\bsfdisk\b/,
		reason: 'partition table change',
	},
	{ pattern: /\bdd\b.*\bof=/, reason: 'dd writing to a device or file' },
	{ pattern: /\b(lvremove|vgremove|pvremove|lvreduce|vgreduce)\b/, reason: 'LVM removal' },
	{
		pattern: /\bcryptsetup\s+(luksFormat|erase|luksKillSlot|luksRemoveKey)\b/,
		reason: 'LUKS key or header change',
	},
	{
		pattern: /\bmdadm\b.*(--zero-superblock|--fail|--remove|--stop)/,
		reason: 'mdadm array change',
	},
	{ pattern: /\b(qm|pct)\s+destroy\b/, reason: 'guest destruction' },
	{ pattern: /\bpvecm\s+delnode\b/, reason: 'cluster node removal' },
	{ pattern: /\bapt(-get)?\b.*\b(remove|purge|autoremove)\b/, reason: 'package removal' },
	{ pattern: /\bdpkg\b.*(--purge|-P)\b/, reason: 'package purge' },
	{
		// Command position only: reboot, shutdown and halt are also qm and pct
		// subcommands.
		pattern: /^(reboot|poweroff|halt|shutdown)(?=\s|$)/,
		reason: 'node power state change',
	},
	{ pattern: /^(init|telinit)\s(?:.*\s)?[06](?=\s|$)/, reason: 'node power state change' },
	{
		pattern: /^systemctl\s+(?:-\S+\s+)*(reboot|poweroff|halt|kexec|emergency|rescue)(?=\s|$)/,
		reason: 'node power state change',
	},
	{
		pattern: new RegExp(`^systemctl\\s+(?:-\\S+\\s+)*(start|isolate)\\s.*${POWER_TARGET.source}`),
		reason: 'node power state change',
	},
	{ pattern: /\/proc\/sysrq-trigger(?=\s|$)/, reason: 'a write to /proc/sysrq-trigger' },
	{
		pattern: />\s*\/dev\/(sd|nvme|vd|zd|md|mapper|zvol|disk\/by-)/,
		reason: 'redirect onto a block device',
	},
	{ pattern: /\bmkswap\b|\bswapoff\b/, reason: 'swap change' },
	{ pattern: /\bpvesm\s+free\b/, reason: 'storage volume removal' },
]

export interface PolicyDecision {
	allowed: boolean
	/** Which rule decided, in words. */
	reason: string
}

/**
 * What ends one command in a line. A lone `&` backgrounds the command before
 * it, so it separates too, but the `&` of `2>&1` or `&>file` belongs to a
 * redirection. A substitution starts a command of its own.
 */
const SEGMENT_SEPARATOR = /\|\||&&|[;|\n`]|\$\(|<\(|>\(|(?<![<>&])&(?![>&])/

/** Syntax that runs a command the check cannot see. */
const OPAQUE_EXPANSION = /\$\(|`|<\(|>\(/

/**
 * Programs that run the command that follows their own arguments. The value
 * names the options that take a separate word as their value.
 */
const WRAPPERS: Readonly<Record<string, RegExp>> = {
	sudo: /^-[CDghprtTuU]$/,
	doas: /^-[Cu]$/,
	env: /^(-u|--unset|-C|--chdir|-S|--split-string)$/,
	exec: /^-a$/,
	command: /^$/,
	nohup: /^$/,
	nice: /^(-n|--adjustment)$/,
	ionice: /^-[cnp]$/,
	timeout: /^(-s|-k|--signal|--kill-after)$/,
	busybox: /^$/,
	xargs: /^-[nIdaELPs]$/,
}

const SHELLS = new Set(['sh', 'bash', 'dash', 'zsh', 'ksh'])

interface ParsedCommand {
	/** Base name of the program that runs, after the wrappers. */
	program: string
	/** The wrappers in front of it, by base name. */
	wrappers: string[]
	/** The program's base name and its arguments, quotes removed. */
	words: string[]
}

export class CommandPolicy {
	readonly allow: readonly ShellPattern[]
	readonly deny: readonly ShellPattern[]
	readonly destructive: 'refuse' | 'allow'

	constructor(policy: ShellPolicy = {}) {
		this.allow = policy.allow ?? []
		this.deny = policy.deny ?? []
		this.destructive = policy.destructive ?? 'refuse'
	}

	/** Throws PveShellPolicyError when the policy refuses the command. */
	check(command: string): void {
		const decision = this.explain(command)
		if (!decision.allowed) throw new PveShellPolicyError({ command, reason: decision.reason })
	}

	/** Decide without running anything. */
	explain(command: string): PolicyDecision {
		const commands = parseCommands(command)
		const programs = commands.flatMap((entry) => [...entry.wrappers, entry.program])

		const denied = this.deny.find((pattern) => matches(pattern, command, programs))
		if (denied !== undefined) {
			return { allowed: false, reason: `the policy denies ${describe(denied)}` }
		}
		if (this.destructive === 'refuse') {
			const lines = commands.map((entry) => entry.words.join(' '))
			const hit = DESTRUCTIVE_PATTERNS.find((entry) =>
				lines.some((line) => entry.pattern.test(line)),
			)
			if (hit) return { allowed: false, reason: `the command destroys data (${hit.reason})` }
		}
		if (this.allow.length > 0) {
			if (OPAQUE_EXPANSION.test(command)) {
				return {
					allowed: false,
					reason: 'a substitution runs a command the allow list cannot see',
				}
			}
			const allowed = this.allow.find((pattern) => matches(pattern, command, programs))
			if (allowed === undefined) {
				return { allowed: false, reason: 'no allow pattern matches the command' }
			}
			return { allowed: true, reason: `the policy allows ${describe(allowed)}` }
		}
		return { allowed: true, reason: 'no rule matches the command' }
	}
}

/**
 * The base name of the program each command in the line runs. A wrapper such
 * as sudo, env or timeout is listed along with the program it hands over to,
 * and a shell's `-c` argument contributes the commands it holds.
 */
export function commandPrograms(command: string): readonly string[] {
	return parseCommands(command).flatMap((entry) => [...entry.wrappers, entry.program])
}

function parseCommands(command: string, depth = 0): ParsedCommand[] {
	const commands: ParsedCommand[] = []
	for (const segment of command.split(SEGMENT_SEPARATOR)) {
		const words = splitWords(segment).map((word, index, all) => {
			const bare = index === all.length - 1 ? word.replace(/[)}]+$/, '') : word
			return index === 0 ? bare.replace(/^[({!]+/, '') : bare
		})
		while (words[0] === '' || /^[({!]+$/.test(words[0] ?? '')) words.shift()
		if (words[0] === undefined) continue

		const wrappers: string[] = []
		let rest = words
		for (let round = 0; round < 8; round++) {
			while (isAssignment(rest[0] ?? '')) rest = rest.slice(1)
			const program = baseName(rest[0] ?? '')
			const valueOptions = WRAPPERS[program]
			if (valueOptions === undefined || rest.length === 1) break
			wrappers.push(program)
			rest = skipWrapperArguments(program, rest.slice(1), valueOptions)
		}
		if (rest.length === 0) continue
		const program = baseName(rest[0] ?? '')
		commands.push({ program, wrappers, words: [program, ...rest.slice(1)] })

		const script = rest.indexOf('-c')
		if (SHELLS.has(program) && script > 0 && depth < 4) {
			const body = rest[script + 1]
			if (body !== undefined) commands.push(...parseCommands(body, depth + 1))
		}
	}
	return commands
}

function skipWrapperArguments(program: string, args: string[], valueOptions: RegExp): string[] {
	let index = 0
	while (index < args.length) {
		const word = args[index] ?? ''
		if (word === '--') return args.slice(index + 1)
		if (word.startsWith('-')) {
			index += valueOptions.test(word) ? 2 : 1
			continue
		}
		if (isAssignment(word)) {
			index++
			continue
		}
		break
	}
	// timeout's first operand is the duration, not the program.
	if (program === 'timeout' && /^\d+(\.\d+)?[smhd]?$/.test(args[index] ?? '')) index++
	return args.slice(index)
}

/**
 * Split a segment into words the way the shell hands them to the program:
 * quotes group and vanish, a backslash keeps the next character.
 */
function splitWords(segment: string): string[] {
	const words: string[] = []
	let word = ''
	let started = false
	let quote: "'" | '"' | undefined
	for (let index = 0; index < segment.length; index++) {
		const char = segment[index] ?? ''
		if (quote === "'") {
			if (char === "'") quote = undefined
			else word += char
			continue
		}
		if (quote === '"') {
			if (char === '"') quote = undefined
			else if (char === '\\' && index + 1 < segment.length) word += segment[++index]
			else word += char
			continue
		}
		if (char === "'" || char === '"') {
			quote = char
			started = true
		} else if (char === '\\' && index + 1 < segment.length) {
			word += segment[++index]
			started = true
		} else if (/\s/.test(char)) {
			if (started) words.push(word)
			word = ''
			started = false
		} else {
			word += char
			started = true
		}
	}
	if (started) words.push(word)
	return words
}

function isAssignment(word: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9_]*=/.test(word)
}

function baseName(word: string): string {
	return word.slice(word.lastIndexOf('/') + 1)
}

function matches(pattern: ShellPattern, command: string, programs: readonly string[]): boolean {
	return typeof pattern === 'string' ? programs.includes(pattern) : pattern.test(command)
}

function describe(pattern: ShellPattern): string {
	return typeof pattern === 'string' ? `'${pattern}'` : String(pattern)
}

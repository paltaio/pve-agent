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
	pattern: RegExp
	reason: string
}

/** Commands the default policy refuses. */
export const DESTRUCTIVE_PATTERNS: readonly DestructivePattern[] = [
	{ pattern: /\brm\s+(-[A-Za-z]*[rRf]|--recursive|--force)/, reason: 'rm with -r or -f' },
	{ pattern: /\bshred\b/, reason: 'shred overwrites file contents' },
	{ pattern: /\bfind\b[^|;&]*\s-delete\b/, reason: 'find -delete' },
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
	{ pattern: /\bdd\b[^|;&]*\bof=/, reason: 'dd writing to a device or file' },
	{ pattern: /\b(lvremove|vgremove|pvremove|lvreduce|vgreduce)\b/, reason: 'LVM removal' },
	{
		pattern: /\bcryptsetup\s+(luksFormat|erase|luksKillSlot|luksRemoveKey)\b/,
		reason: 'LUKS key or header change',
	},
	{
		pattern: /\bmdadm\b[^|;&]*(--zero-superblock|--fail|--remove|--stop)/,
		reason: 'mdadm array change',
	},
	{ pattern: /\b(qm|pct)\s+destroy\b/, reason: 'guest destruction' },
	{ pattern: /\bpvecm\s+delnode\b/, reason: 'cluster node removal' },
	{ pattern: /\bapt(-get)?\b[^|;&]*\b(remove|purge|autoremove)\b/, reason: 'package removal' },
	{ pattern: /\bdpkg\b[^|;&]*(--purge|-P)\b/, reason: 'package purge' },
	{
		// Command position only: reboot, shutdown and halt are also qm and pct
		// subcommands.
		pattern: /(?:^|[;&|(`\n]|\bsudo\s+)\s*(?:\S*\/)?(reboot|poweroff|halt|shutdown)\b/,
		reason: 'node power state change',
	},
	{
		pattern: /\bsystemctl\s+(reboot|poweroff|halt|kexec|emergency|rescue)\b/,
		reason: 'node power state change',
	},
	{ pattern: />\s*\/dev\/(sd|nvme|vd|zd|md|mapper)/, reason: 'redirect onto a block device' },
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
 * redirection.
 */
const SEGMENT_SEPARATOR = /\|\||&&|[;|\n]|(?<![<>&])&(?![>&])/

/** Syntax that runs a command the check cannot see. */
const OPAQUE_EXPANSION = /\$\(|`|<\(|>\(/

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
		const programs = commandPrograms(command)

		const denied = this.deny.find((pattern) => matches(pattern, command, programs))
		if (denied !== undefined) {
			return { allowed: false, reason: `the policy denies ${describe(denied)}` }
		}
		if (this.destructive === 'refuse') {
			const hit = DESTRUCTIVE_PATTERNS.find((entry) => entry.pattern.test(command))
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

/** The base name of the program each command in the line runs. */
export function commandPrograms(command: string): readonly string[] {
	const programs: string[] = []
	for (const segment of command.split(SEGMENT_SEPARATOR)) {
		const words = segment
			.replace(/^[({\s]+/, '')
			.split(/\s+/)
			.filter((word) => word.length > 0 && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word))
		const head = words[0]
		if (head === undefined) continue
		const cleaned = head.replace(/^["']|["')}]+$/g, '')
		programs.push(cleaned.slice(cleaned.lastIndexOf('/') + 1))
	}
	return programs
}

function matches(pattern: ShellPattern, command: string, programs: readonly string[]): boolean {
	return typeof pattern === 'string' ? programs.includes(pattern) : pattern.test(command)
}

function describe(pattern: ShellPattern): string {
	return typeof pattern === 'string' ? `'${pattern}'` : String(pattern)
}

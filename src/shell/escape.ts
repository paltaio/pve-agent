/**
 * Quoting and value checks for command lines built from untrusted values.
 *
 * The checks cover what quoting cannot fix: a NUL byte, a number that is not
 * one, and a file name that climbs out of the directory it is joined to.
 */

import { PveShellPolicyError } from './errors.ts'

/**
 * Wrap a value in single quotes so a POSIX shell reads it as one literal word.
 * An embedded single quote is closed, escaped and reopened.
 *
 * A leading dash survives quoting, so an operand built from a value still
 * needs a `--` in front of it.
 */
export function shQuote(value: string): string {
	if (typeof value !== 'string') {
		refuse(
			String(value),
			`shQuote takes a string, and a ${typeof value} would reach the shell unquoted`,
		)
	}
	if (value.includes('\0')) {
		refuse(
			value,
			`execve stops at a NUL byte, so the node would act on '${value.slice(0, value.indexOf('\0'))}' rather than the value passed`,
		)
	}
	if (value.length === 0) return "''"
	if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value
	return `'${value.replace(/'/g, `'\\''`)}'`
}

/** Join an argument vector into a command line, quoting each element. */
export function shJoin(argv: readonly string[]): string {
	return argv.map(shQuote).join(' ')
}

/**
 * A quoted here-document carrying `content` verbatim: no expansion happens
 * inside it. The result starts with the `<<` operator and ends with the
 * terminator line, so it goes at the end of a command line:
 *
 *     `cat > /etc/motd ${shHeredoc(text)}`
 *
 * A here-document always ends in a newline; content without one gains it.
 * The terminator is chosen so no line of the content equals it.
 */
export function shHeredoc(content: string, terminator = 'PVE_EOF'): string {
	if (content.includes('\0')) refuse(content, 'a here-document cannot carry a NUL byte')
	const lines = content.split('\n')
	let word = terminator
	for (let n = 1; lines.includes(word); n++) word = `${terminator}_${n}`
	const body = content.endsWith('\n') || content.length === 0 ? content : `${content}\n`
	return `<<'${word}'\n${body}${word}`
}

/** Settings a command line runs under. */
export interface ShellContext {
	cwd?: string
	env?: Readonly<Record<string, string>>
}

/**
 * Prefix a command line with the `cd` and the exports it asked for. A `cd`
 * that fails ends the line with its own exit code, so the command never runs
 * in the wrong directory.
 */
export function shWrap(command: string, context: ShellContext): string {
	const prelude: string[] = []
	if (context.cwd !== undefined) prelude.push(`cd -- ${shQuote(context.cwd)} || exit $?`)
	for (const [name, value] of Object.entries(context.env ?? {})) {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
			refuse(name, `'${name}' is not a variable name a POSIX shell accepts`)
		}
		prelude.push(`export ${name}=${shQuote(value)}`)
	}
	return prelude.length === 0 ? command : `${prelude.join('; ')}\n${command}`
}

/**
 * Check a value that goes into a command line as a bare number. TypeScript
 * does not stop a JavaScript caller passing a string, and a string in that
 * position is unquoted shell input.
 */
export function assertSafeInteger(value: number, name: string): number {
	if (!Number.isSafeInteger(value)) {
		refuse(String(value), `${name} goes into a command line as a number, and '${value}' is not one`)
	}
	return value
}

/**
 * Check a value that is joined to a fixed directory, so the result stays in
 * that directory.
 */
export function assertPathSegment(value: string, name: string): string {
	if (
		value.length === 0 ||
		value === '.' ||
		value.includes('..') ||
		value.includes('/') ||
		value.includes('\0')
	) {
		refuse(
			value,
			`${name} names one file inside a fixed directory, and '${value}' does not: it cannot be empty, '.', or hold '..', '/' or a NUL`,
		)
	}
	return value
}

function refuse(value: string, reason: string): never {
	throw new PveShellPolicyError({ command: value, reason })
}

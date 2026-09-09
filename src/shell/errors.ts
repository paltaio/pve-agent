/**
 * The root-shell failures, one class per `ShellErrorKind`.
 *
 * Each carries the fields a caller branches on: the node, the command, the
 * exit code with its output, or the deadline that passed.
 */

import { PveShellError } from '../core/errors.ts'

/** No SSH key and no root@pam ticket, so no transport can reach a root shell. */
export class PveShellCredentialError extends PveShellError {
	readonly node: string

	constructor(node: string, message: string) {
		super('credential', message)
		this.node = node
	}
}

/** The transport failed to connect, or dropped while a command was running. */
export class PveShellTransportError extends PveShellError {
	readonly node: string
	readonly transport: string

	constructor(args: { node: string; transport: string; message: string; cause?: unknown }) {
		super('transport', args.message, { cause: args.cause })
		this.node = args.node
		this.transport = args.transport
	}
}

/** The policy refused the command before anything was sent. */
export class PveShellPolicyError extends PveShellError {
	readonly command: string
	readonly reason: string

	constructor(args: { command: string; reason: string }) {
		super('policy', `${args.reason}: ${args.command}`)
		this.command = args.command
		this.reason = args.reason
	}
}

/** A command exited non-zero and the caller asked for the exit code to be checked. */
export class PveShellCommandError extends PveShellError {
	readonly node: string
	readonly command: string
	readonly exitCode: number
	readonly stdout: string
	readonly stderr: string

	constructor(args: {
		node: string
		command: string
		exitCode: number
		stdout: string
		stderr: string
	}) {
		const detail = (args.stderr.trim() || args.stdout.trim() || 'no output').slice(0, 2000)
		super('command', `Command on ${args.node} exited ${args.exitCode}: ${args.command}\n${detail}`)
		this.node = args.node
		this.command = args.command
		this.exitCode = args.exitCode
		this.stdout = args.stdout
		this.stderr = args.stderr
	}
}

/** A command ran but printed something the helper cannot read. */
export class PveShellOutputError extends PveShellError {
	readonly output: string

	constructor(args: { what: string; output: string; cause?: unknown }) {
		super('output', `${args.what}: ${args.output.trim().slice(0, 500) || 'no output'}`, {
			cause: args.cause,
		})
		this.output = args.output
	}
}

/** A command produced no result before its deadline. */
export class PveShellTimeoutError extends PveShellError {
	readonly node: string
	readonly command: string
	readonly timeoutMs: number
	/** Whatever the transport had read when the deadline passed. */
	readonly partialOutput: string

	constructor(args: { node: string; command: string; timeoutMs: number; partialOutput?: string }) {
		const tail = args.partialOutput ? `\nOutput so far:\n${args.partialOutput.slice(-2000)}` : ''
		super(
			'timeout',
			`Command on ${args.node} produced no result within ${args.timeoutMs} ms: ${args.command}${tail}`,
		)
		this.node = args.node
		this.command = args.command
		this.timeoutMs = args.timeoutMs
		this.partialOutput = args.partialOutput ?? ''
	}
}

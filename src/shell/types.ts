/**
 * The seam both root-shell transports sit behind.
 *
 * SSH and the termproxy websocket answer the same calls. Every command line
 * is interpreted by a POSIX shell running as root on the node, so a value
 * from outside goes through `shQuote` before it lands in one.
 */

export type ShellTransportKind = 'ssh' | 'termproxy'

export interface RunOptions {
	/** Give up after this many milliseconds. Transports set their own default. */
	timeoutMs?: number
	/** Bytes fed to the command's standard input. */
	input?: string | Uint8Array
	/** Throw PveShellCommandError when the command exits non-zero. */
	check?: boolean
	/** Variables exported before the command runs. */
	env?: Readonly<Record<string, string>>
	/** Directory the command runs in. */
	cwd?: string
}

export interface CommandResult {
	stdout: string
	stderr: string
	exitCode: number
	durationMs: number
}

export interface ShellTransport {
	readonly kind: ShellTransportKind
	readonly node: string
	/** Human-readable target, such as 'ssh root@192.168.80.21'. */
	readonly description: string

	run(command: string, options?: RunOptions): Promise<CommandResult>
	/** Copy a file from this machine to the node. */
	upload(localPath: string, remotePath: string): Promise<void>
	/** Copy a file from the node to this machine. */
	download(remotePath: string, localPath: string): Promise<void>
	close(): Promise<void>
}

/**
 * A string names a program: it matches when any command in the line (each
 * side of a pipe, `;`, `&&`, `||` or `&`) runs that program, by base name. A
 * RegExp is tested against the whole command line.
 */
export type ShellPattern = string | RegExp

/**
 * What a shell may run. The check is a rail for a caller that builds command
 * lines from generated text, not a sandbox: a shell has enough indirection
 * that a determined caller can hide anything from it.
 */
export interface ShellPolicy {
	/**
	 * Patterns a command must match one of. Unset or empty lets every command
	 * through to the deny check. A line holding a command substitution or a
	 * process substitution runs programs the check cannot see, so an allow
	 * list refuses it.
	 */
	allow?: readonly ShellPattern[]
	/** Patterns that refuse a command. Checked before `allow`. */
	deny?: readonly ShellPattern[]
	/**
	 * Whether the built-in patterns for commands that destroy data, wipe
	 * disks, remove packages or power the node off refuse a command.
	 * Defaults to 'refuse'.
	 */
	destructive?: 'refuse' | 'allow'
}

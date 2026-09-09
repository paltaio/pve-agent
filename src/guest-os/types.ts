/**
 * Running commands inside a guest, whichever OS it runs.
 *
 * A QEMU guest is reached through the guest agent and a container through
 * `pct exec` on its node. Both answer the same executor call, so the OS
 * helpers built on it are written once per OS rather than once per
 * transport.
 */

export type GuestOsKind = 'linux' | 'darwin' | 'windows'

export interface GuestRunOptions {
	/** Give up waiting after this long. Defaults to 30 seconds. */
	timeoutMs?: number
	/** Text fed to the command's standard input. */
	input?: string
	signal?: AbortSignal
}

export interface GuestRunResult {
	/**
	 * The process exit code; 128 plus the signal number for a process a signal
	 * killed, and -1 while the process has not exited.
	 */
	exitCode: number
	stdout: string
	stderr: string
	/**
	 * True when the wait gave up before the process exited. The process may
	 * still be running inside the guest.
	 */
	timedOut: boolean
	/** True when the transport cut stdout or stderr short. The guest agent stops at 16 MiB. */
	truncated: boolean
}

/** Runs an argument vector inside one guest, with no shell in between. */
export interface GuestExecutor {
	readonly vmid: number
	exec(argv: readonly string[], options?: GuestRunOptions): Promise<GuestRunResult>
}

export interface GuestOsInfo {
	os: GuestOsKind
	/** The os-release ID on Linux, `macos`, or `windows`. */
	id: string
	name: string
	version: string
	prettyName: string
	kernel: string
	arch: string
	/** Every field the guest reported, keyed as the guest spells it. */
	raw: Readonly<Record<string, string>>
}

/**
 * The commands every guest OS answers. `run` takes one command line for the
 * OS's command interpreter: `/bin/sh -c` on Linux and macOS, `cmd.exe /c` on
 * Windows. `sh` takes a script for the OS's scripting shell: `/bin/sh` again
 * on Linux and macOS, PowerShell on Windows.
 */
export interface GuestOs {
	readonly os: GuestOsKind
	readonly vmid: number
	readonly executor: GuestExecutor

	/** Run a program with an explicit argument vector. */
	exec(argv: readonly string[], options?: GuestRunOptions): Promise<GuestRunResult>
	/** Run one command line. A non-zero exit is a result, not an error. */
	run(command: string, options?: GuestRunOptions): Promise<GuestRunResult>
	/**
	 * Run one command line and return its stdout without trailing whitespace.
	 * Throws GuestCommandError on a non-zero exit and PveTimeoutError when the
	 * command is still running at the deadline.
	 */
	output(command: string, options?: GuestRunOptions): Promise<string>
	/** Run a script, which may span lines, in the OS's scripting shell. */
	sh(script: string, options?: GuestRunOptions): Promise<GuestRunResult>

	/** Read a file as text. Content moves as base64, so the guest's code page cannot alter it. */
	readFile(path: string, options?: GuestRunOptions): Promise<string>
	readFileBytes(path: string, options?: GuestRunOptions): Promise<Uint8Array>
	/** Write a file, replacing it. A string is written as UTF-8 without a byte order mark. */
	writeFile(path: string, content: string | Uint8Array, options?: GuestRunOptions): Promise<void>
	/** Delete one file. A missing file is an error. */
	delete(path: string, options?: GuestRunOptions): Promise<void>
	exists(path: string, options?: GuestRunOptions): Promise<boolean>
	/** Fetch a URL into a file in the guest, replacing it. */
	download(url: string, destination: string, options?: GuestRunOptions): Promise<void>

	hostname(options?: GuestRunOptions): Promise<string>
	osInfo(options?: GuestRunOptions): Promise<GuestOsInfo>

	/** Ask the OS to restart. The command usually outlives the connection that reads its result. */
	reboot(options?: GuestRunOptions): Promise<GuestRunResult>
	/** Ask the OS to power off. */
	shutdown(options?: GuestRunOptions): Promise<GuestRunResult>
}

/**
 * Opening the OS helper for a guest.
 *
 * A VM's config names its OS family in `ostype`; a macOS VM is filed under
 * `other` and recognised by the Apple SMC device in its `args`. When the
 * config says nothing usable, the guest agent is asked. A container runs
 * Linux and has no agent, so its helper runs `pct exec` on a root shell of
 * its node.
 */

import { PveApiError, PveConfigError, PveConnectionError, PveTimeoutError } from '../core/errors.ts'
import { pollUntil, type PollOptions } from '../core/poll.ts'
import type { AgentOsInfo, QemuAgent } from '../guest/agent.ts'
import type { LxcApi } from '../guest/lxc.ts'
import type { QemuApi } from '../guest/qemu.ts'
import type { QemuConfig } from '../guest/types.ts'
import type { NodeShell } from '../shell/node-shell.ts'
import { DarwinGuest } from './darwin.ts'
import { pctExecutor, qemuAgentExecutor } from './executor.ts'
import { LinuxGuest } from './linux.ts'
import type { GuestExecutor, GuestOsKind, GuestRunResult } from './types.ts'
import { WindowsGuest } from './windows.ts'

export type AnyGuestOs = LinuxGuest | DarwinGuest | WindowsGuest

export interface OpenGuestOsOptions {
	/** Build this helper without reading the config or asking the guest. */
	os?: GuestOsKind
	/** Ask the guest agent what runs inside rather than reading the config. */
	detect?: boolean
	/** A root shell on the container's node. Required for a container. */
	shell?: NodeShell
}

export interface WaitForAgentOptions {
	/** Give up after this long. Defaults to 5 minutes. */
	timeoutMs?: number
	/** First poll delay. Defaults to 1 second. */
	initialDelayMs?: number
	/** Ceiling for the backoff. Defaults to 5 seconds. */
	maxDelayMs?: number
	signal?: AbortSignal
}

/** The OS family a QEMU `ostype` value stands for, or undefined for `other` and `solaris`. */
export function guestOsFromOstype(ostype: string | undefined): GuestOsKind | undefined {
	if (ostype === undefined) return undefined
	if (/^l\d/.test(ostype)) return 'linux'
	if (/^w/.test(ostype)) return 'windows'
	return undefined
}

/** Whether the config carries the Apple SMC device a macOS guest boots with. */
export function hasMacosHint(config: QemuConfig): boolean {
	const args = config.raw['args']
	return typeof args === 'string' && /applesmc|\bosk=/.test(args)
}

/** The OS family behind what the guest agent's get-osinfo reported. */
export function guestOsFromOsInfo(info: AgentOsInfo): GuestOsKind | undefined {
	const label = `${info.id ?? ''} ${info.name ?? ''}`
	if (/windows/i.test(label)) return 'windows'
	if (/darwin|macos/i.test(label)) return 'darwin'
	return info.id ? 'linux' : undefined
}

/** The helper class for an OS family over an executor. */
export function guestOsFor(os: GuestOsKind, executor: GuestExecutor): AnyGuestOs {
	if (os === 'linux') return new LinuxGuest(executor)
	if (os === 'darwin') return new DarwinGuest(executor)
	return new WindowsGuest(executor)
}

/**
 * Ask the guest what it runs: get-osinfo first, then `uname -s`, then
 * `cmd /c ver`.
 *
 * A probe that never reached the guest keeps its own error: a stopped agent,
 * a missing privilege or an unreachable node is rethrown as it came. Only a
 * guest that answered and named nothing known is reported as unidentified.
 */
export async function detectGuestOs(agent: QemuAgent): Promise<GuestOsKind> {
	let failure: unknown
	try {
		const os = guestOsFromOsInfo(await agent.osInfo())
		if (os !== undefined) return os
	} catch (error) {
		failure = error
	}

	const executor = qemuAgentExecutor(agent)
	const probe = async (run: () => Promise<GuestRunResult>): Promise<GuestRunResult | undefined> => {
		try {
			return await run()
		} catch (error) {
			failure ??= error
			return undefined
		}
	}

	const uname = await probe(() => executor.exec(['/bin/sh', '-c', 'uname -s']))
	const kernel = uname?.exitCode === 0 ? uname.stdout.trim() : ''
	if (/^Linux/i.test(kernel)) return 'linux'
	if (/^Darwin/i.test(kernel)) return 'darwin'

	const ver = await probe(() => new WindowsGuest(executor).cmd('ver'))
	if (ver?.exitCode === 0 && /Windows/i.test(ver.stdout)) return 'windows'

	if (failure !== undefined) throw failure
	throw new PveConfigError(
		`Guest ${agent.vmid} answered neither get-osinfo, 'uname -s' nor 'cmd /c ver', so its OS could not be identified.`,
	)
}

async function guestOsFromConfig(vm: QemuApi): Promise<GuestOsKind | undefined> {
	const config = await vm.getConfig()
	return guestOsFromOstype(config.ostype) ?? (hasMacosHint(config) ? 'darwin' : undefined)
}

/**
 * Open the OS helper for a guest. A VM's helper is picked from `os`, else
 * from its config, else by asking the agent. A container's helper runs
 * through `pct exec` on `shell`, which has to be open on the container's
 * node.
 */
export function openGuestOs(vm: QemuApi, options?: OpenGuestOsOptions): Promise<AnyGuestOs>
export function openGuestOs(
	ct: LxcApi,
	options: OpenGuestOsOptions & { shell: NodeShell },
): Promise<LinuxGuest>
export async function openGuestOs(
	target: QemuApi | LxcApi,
	options: OpenGuestOsOptions = {},
): Promise<AnyGuestOs> {
	if (target.type === 'lxc') {
		if (options.shell === undefined) {
			throw new PveConfigError(
				`Container ${target.vmid} has no guest agent; pass a NodeShell open on ${target.node} so pct exec can run there.`,
			)
		}
		if (options.shell.node !== target.node) {
			throw new PveConfigError(
				`Container ${target.vmid} lives on ${target.node}, and the shell given is open on ${options.shell.node}.`,
			)
		}
		return new LinuxGuest(pctExecutor(options.shell, target.vmid))
	}

	const os =
		options.os ??
		(options.detect ? undefined : await guestOsFromConfig(target)) ??
		(await detectGuestOs(target.agent))
	return guestOsFor(os, qemuAgentExecutor(target.agent))
}

/**
 * Poll `agent.ping()` until the agent answers. A 500 from the node and a
 * connection failure both mean "not yet"; any other error is rethrown.
 * Throws PveTimeoutError when the deadline passes.
 */
export async function waitForAgent(
	agent: QemuAgent,
	options: WaitForAgentOptions = {},
): Promise<void> {
	const timeoutMs = options.timeoutMs ?? 5 * 60_000
	const pollOptions: PollOptions<boolean> = {
		done: (answered) => answered,
		onTimeout: () => {
			throw new PveTimeoutError({
				what: `the guest agent of VM ${agent.vmid} to answer`,
				waitedMs: timeoutMs,
				detail:
					'the VM may still be booting, the agent may not be installed, or the config may lack agent=1',
			})
		},
		timeoutMs,
		initialDelayMs: options.initialDelayMs ?? 1000,
		maxDelayMs: options.maxDelayMs ?? 5000,
	}
	if (options.signal !== undefined) pollOptions.signal = options.signal
	await pollUntil(async () => {
		try {
			await agent.ping()
			return true
		} catch (error) {
			if (error instanceof PveApiError || error instanceof PveConnectionError) return false
			throw error
		}
	}, pollOptions)
}

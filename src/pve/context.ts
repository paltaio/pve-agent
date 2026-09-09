/**
 * What a node or guest handle needs from the cluster it came from.
 *
 * A handle is a value object holding a name and a vmid. The sessions it
 * reaches for belong to the cluster and are keyed by vmid or node name, so
 * one `close()` on the cluster tears down every socket and shell a handle
 * opened.
 */

import type { SerialConsole, SerialConsoleOptions } from '../console/terminal.ts'
import type { VncSession } from '../console/vnc.ts'
import type { PveClient } from '../core/client.ts'
import type { GuestRef } from '../guest/types.ts'
import type { NodeShell } from '../shell/node-shell.ts'

/** Settings for a serial console the cluster opens. The guest and the transport are the cluster's. */
export type SerialOpenOptions = Omit<
	SerialConsoleOptions,
	'client' | 'node' | 'vmid' | 'type' | 'socketFactory'
>

export interface PveContext {
	readonly client: PveClient
	/** A root shell on a node, opened on first use and shared from then on. */
	nodeShell(node: string): Promise<NodeShell>
	/** The VNC session of a guest, opened on first use and shared from then on. */
	vncSession(ref: Required<GuestRef>): Promise<VncSession>
	/** Closes the VNC session of a guest, if one is open or opening. */
	closeVncSession(vmid: number): Promise<void>
	/** The serial console of a guest, opened on first use and shared from then on. */
	serialConsole(ref: Required<GuestRef>, options?: SerialOpenOptions): Promise<SerialConsole>
	/** Closes the serial console of a guest, if one is open or opening. */
	closeSerialConsole(vmid: number): Promise<void>
}

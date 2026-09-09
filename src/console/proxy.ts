/**
 * The PVE calls that open a console: vncproxy spawns a proxy worker on the
 * node, and vncwebsocket carries the stream from it.
 *
 * The node ties a VNC ticket to the user that asked for it and checks the
 * WebSocket against the same user, so the proxy call and the socket present
 * one credential. The login ticket comes first because PVE accepts it on
 * every console endpoint.
 */

import type { PveAuth } from '../core/auth.ts'
import type { PveClient } from '../core/client.ts'
import { PveConsoleError, type AuthTier } from '../core/errors.ts'
import type { NodesQemuTermproxyPostParams } from '../generated/types.ts'
import { guestPath, type GuestRef, type GuestType } from '../guest/types.ts'

export type { GuestRef, GuestType }

/** A guest, or the API path of whatever else spawns a proxy worker, such as `/nodes/pve1`. */
export type ConsoleTarget = GuestRef | string

/** A VM serial port a terminal proxy can attach to. */
export type SerialPort = NonNullable<NodesQemuTermproxyPostParams['serial']>

/** What a node hands back when it spawns a terminal proxy worker. */
export interface TermProxyTicket {
	/** TCP port of the proxy worker, as the node reports it. */
	port: string
	/** Goes in the vncwebsocket query string and in the login frame. */
	ticket: string
	/** The user the ticket is tied to; the login frame names it. */
	user: string
	upid?: string
}

export interface TermProxyParams {
	/** The VM serial port to attach. Without it the proxy opens the VM's display. */
	serial?: SerialPort
}

/** What a node hands back when it spawns a VNC proxy worker. */
export interface VncProxyTicket {
	/** TCP port of the proxy worker, as the node reports it. */
	port: string
	/** Goes in the vncwebsocket query string. Valid for about 40 seconds. */
	ticket: string
	user: string
	/** One-time password answering the RFB security type 2 challenge. */
	password?: string
	upid?: string
}

function targetPath(target: ConsoleTarget): string {
	return typeof target === 'string' ? target : guestPath(target)
}

/**
 * Spawns a VNC proxy worker for a running guest. QEMU is asked for a one-time
 * password; the LXC endpoint has no such parameter and answers with one anyway.
 */
export async function requestVncProxy(client: PveClient, guest: GuestRef): Promise<VncProxyTicket> {
	const params: Record<string, boolean> = { websocket: true }
	if ((guest.type ?? 'qemu') === 'qemu') params['generate-password'] = true

	const raw = await client.post<Record<string, unknown>>(`${guestPath(guest)}/vncproxy`, params, {
		tier: consoleTier(client.auth),
	})
	const ticket: VncProxyTicket = {
		port: readString(raw, 'port', 'vncproxy'),
		ticket: readString(raw, 'ticket', 'vncproxy'),
		user: typeof raw['user'] === 'string' ? raw['user'] : '',
	}
	if (typeof raw['password'] === 'string' && raw['password'].length > 0) {
		ticket.password = raw['password']
	}
	if (typeof raw['upid'] === 'string') ticket.upid = raw['upid']
	return ticket
}

/**
 * Spawns a terminal proxy worker for a guest, or for a node when given its
 * path. Its stream runs over vncwebsocket like the VNC one, with the framing
 * `pty.ts` describes.
 */
export async function requestTermProxy(
	client: PveClient,
	target: ConsoleTarget,
	params: TermProxyParams = {},
): Promise<TermProxyTicket> {
	const raw = await client.post<Record<string, unknown>>(
		`${targetPath(target)}/termproxy`,
		params,
		{ tier: consoleTier(client.auth) },
	)
	const ticket: TermProxyTicket = {
		port: readString(raw, 'port', 'termproxy'),
		ticket: readString(raw, 'ticket', 'termproxy'),
		user: readString(raw, 'user', 'termproxy'),
	}
	if (typeof raw['upid'] === 'string') ticket.upid = raw['upid']
	return ticket
}

/** The vncwebsocket URL for a proxy worker. */
export function consoleWebSocketUrl(
	baseUrl: string,
	target: ConsoleTarget,
	port: string,
	vncticket: string,
): string {
	const authority = baseUrl.replace(/^https?:\/\//, '')
	const query = `port=${encodeURIComponent(port)}&vncticket=${encodeURIComponent(vncticket)}`
	return `wss://${authority}/api2/json${targetPath(target)}/vncwebsocket?${query}`
}

/** The credential the proxy call and the socket share. */
export function consoleTier(auth: PveAuth): AuthTier {
	return auth.has('ticket') ? 'ticket' : 'token'
}

/**
 * Headers that authenticate the WebSocket upgrade for `consoleTier`. The
 * cookie value is URL-encoded because the server runs it through
 * `uri_unescape` before comparing it.
 */
export async function consoleAuthHeaders(auth: PveAuth): Promise<Record<string, string>> {
	if (consoleTier(auth) === 'ticket') {
		const ticket = await auth.getTicket()
		return { Cookie: `PVEAuthCookie=${encodeURIComponent(ticket.ticket)}` }
	}
	return { Authorization: auth.tokenHeader() }
}

function readString(raw: Record<string, unknown>, key: string, endpoint: string): string {
	const value = raw[key]
	if (typeof value === 'string') return value
	if (typeof value === 'number') return String(value)
	throw new PveConsoleError(`${endpoint} answered without a '${key}' field`)
}

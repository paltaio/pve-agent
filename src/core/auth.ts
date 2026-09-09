/**
 * Credential handling for the PVE API.
 *
 * A client can hold an API token, a login ticket, or both. The token reaches
 * almost every endpoint and skips CSRF. A ticket is needed for the endpoints
 * and parameters whose handlers compare the caller against 'root@pam', because
 * even a root-owned token fails that comparison.
 *
 * Everything is instance state. Two PveAuth objects in one process never see
 * each other's tickets.
 */

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PveApiError, PveAuthError, PveConfigError, type AuthTier } from './errors.ts'
import type { HttpClient } from './http.ts'
import { parseBoolean } from './values.ts'

export interface PveConnection {
	host: string
	port: number
	verifySsl: boolean
	/** Node used when a call does not name one. */
	node?: string
}

export interface TokenCredential {
	/** Full token id, `user@realm!tokenname`. */
	id: string
	secret: string
}

export interface TicketCredential {
	username: string
	password: string
}

export interface PveCredentials {
	connection: PveConnection
	token?: TokenCredential
	ticket?: TicketCredential
}

/** Overrides applied on top of the environment and the credential file. */
export interface CredentialInput {
	host?: string
	port?: number
	verifySsl?: boolean
	node?: string
	username?: string
	password?: string
	tokenId?: string
	tokenSecret?: string
	/** Path to a shell-style env file. Defaults to PVE_ENV_FILE or ./pve.env. */
	envFile?: string
}

export interface PveTicket {
	ticket: string
	csrfToken: string
	username: string
	/** Epoch milliseconds when the server-side ticket stops being valid. */
	expiresAt: number
}

const TICKET_LIFETIME_MS = 2 * 60 * 60 * 1000
const TICKET_RENEW_MARGIN_MS = 15 * 60 * 1000

/**
 * Resolve credentials from explicit input, then process env, then a shell-style
 * env file. Only the host is required here: PveAuth reports which tiers came
 * out of it, and the client names the missing variable when a call needs a
 * tier that is absent.
 */
export function loadCredentials(input: CredentialInput = {}): PveCredentials {
	const file = readEnvFile(input.envFile ?? process.env['PVE_ENV_FILE'] ?? resolve('pve.env'))
	const pick = (key: string): string | undefined => process.env[key] || file[key] || undefined

	const host = input.host ?? pick('PVE_HOST')
	if (!host) {
		throw new PveConfigError(
			'No PVE host. Pass { host }, set PVE_HOST, or put PVE_HOST in a pve.env file.',
		)
	}

	const connection: PveConnection = {
		host,
		port: input.port ?? parsePort(pick('PVE_PORT')),
		verifySsl: input.verifySsl ?? parseVerifySsl(pick('PVE_VERIFY_SSL')),
	}
	const node = input.node ?? pick('PVE_NODE')
	if (node) connection.node = node

	const credentials: PveCredentials = { connection }

	const username = input.username ?? pick('PVE_USER')
	const password = input.password ?? pick('PVE_PASSWORD')
	if (username && password) credentials.ticket = { username, password }

	const tokenId = input.tokenId ?? pick('PVE_TOKEN_ID')
	const tokenSecret = input.tokenSecret ?? pick('PVE_TOKEN_SECRET')
	if (tokenId && tokenSecret) {
		credentials.token = { id: qualifyTokenId(tokenId, username), secret: tokenSecret }
	}

	return credentials
}

function parsePort(value: string | undefined): number {
	if (value === undefined) return 8006
	const port = Number(value)
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		throw new PveConfigError(`PVE_PORT '${value}' is not a port number.`)
	}
	return port
}

function parseVerifySsl(value: string | undefined): boolean {
	if (value === undefined) return true
	const parsed = parseBoolean(value.trim())
	if (parsed === undefined) {
		throw new PveConfigError(`PVE_VERIFY_SSL '${value}' is not a boolean. Use 1 or 0.`)
	}
	return parsed
}

/**
 * PVE wants the token id as `user@realm!name`. A bare `name` is joined with the
 * configured username so both spellings work in config.
 */
function qualifyTokenId(tokenId: string, username: string | undefined): string {
	if (tokenId.includes('!')) return tokenId
	if (!username) {
		throw new PveConfigError(
			`PVE_TOKEN_ID '${tokenId}' has no user part. Use 'user@realm!${tokenId}' or set PVE_USER.`,
		)
	}
	return `${username}!${tokenId}`
}

const ENV_LINE = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/

function readEnvFile(path: string): Record<string, string> {
	const out: Record<string, string> = {}
	if (!existsSync(path)) return out
	for (const rawLine of readFileSync(path, 'utf8').split(/\r?\n/)) {
		const line = rawLine.trim()
		if (!line || line.startsWith('#')) continue
		const match = ENV_LINE.exec(line)
		if (!match) continue
		const [, key = '', value = ''] = match
		out[key] = unquote(value.trim())
	}
	return out
}

/** Strips one layer of shell quoting; a bare value is kept as written. */
function unquote(value: string): string {
	if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
		return value.slice(1, -1).replace(/'\\''/g, "'")
	}
	if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
		return value.slice(1, -1).replace(/\\(["\\$`])/g, '$1')
	}
	return value
}

interface TicketPayload {
	ticket: string
	csrfToken: string
	username: string | undefined
}

type LoginResult = { ok: true; payload: TicketPayload } | { ok: false; detail: string }

function readTicketPayload(payload: unknown): TicketPayload | undefined {
	if (typeof payload !== 'object' || payload === null || !('data' in payload)) return undefined
	const data = payload.data
	if (typeof data !== 'object' || data === null) return undefined
	const ticket = 'ticket' in data ? data.ticket : undefined
	const csrfToken = 'CSRFPreventionToken' in data ? data.CSRFPreventionToken : undefined
	const username = 'username' in data ? data.username : undefined
	if (typeof ticket !== 'string' || typeof csrfToken !== 'string') return undefined
	return { ticket, csrfToken, username: typeof username === 'string' ? username : undefined }
}

/** The `message` of a JSON envelope, or '' for any other body. */
function envelopeMessage(body: string): string {
	try {
		const parsed: unknown = JSON.parse(body)
		if (typeof parsed === 'object' && parsed !== null && 'message' in parsed) {
			const message = parsed.message
			if (typeof message === 'string') return message.trim().slice(0, 200)
		}
	} catch {
		// A proxy answers with its own page; nothing in it names the failure.
	}
	return ''
}

export class PveAuth {
	readonly connection: PveConnection

	private readonly http: HttpClient
	private readonly token: TokenCredential | undefined
	private readonly ticketCredential: TicketCredential | undefined
	private currentTicket: PveTicket | undefined
	private pending: Promise<PveTicket> | undefined

	constructor(credentials: PveCredentials, http: HttpClient) {
		this.connection = credentials.connection
		this.token = credentials.token
		this.ticketCredential = credentials.ticket
		this.http = http
		if (!this.token && !this.ticketCredential) {
			throw new PveConfigError(
				'No credentials. Set PVE_TOKEN_ID and PVE_TOKEN_SECRET, or PVE_USER and PVE_PASSWORD.',
			)
		}
	}

	get baseUrl(): string {
		return `https://${this.connection.host}:${this.connection.port}`
	}

	get verifySsl(): boolean {
		return this.connection.verifySsl
	}

	/** Tiers this client can present, in the order the client prefers them. */
	get tiers(): readonly AuthTier[] {
		const tiers: AuthTier[] = []
		if (this.token) tiers.push('token')
		if (this.ticketCredential) tiers.push('ticket')
		return tiers
	}

	has(tier: AuthTier): boolean {
		return tier === 'token' ? this.token !== undefined : this.ticketCredential !== undefined
	}

	/** The user the ticket tier logs in as, or undefined when there is no ticket. */
	get ticketUsername(): string | undefined {
		return this.ticketCredential?.username
	}

	/** True when the ticket tier can satisfy the handlers that test for root@pam. */
	get hasRootTicket(): boolean {
		return this.ticketCredential?.username === 'root@pam'
	}

	/** Value for the Authorization header. */
	tokenHeader(): string {
		if (!this.token) {
			throw new PveConfigError('No API token. Set PVE_TOKEN_ID and PVE_TOKEN_SECRET.')
		}
		return `PVEAPIToken=${this.token.id}=${this.token.secret}`
	}

	/** A valid ticket, logging in or renewing once the cached one enters its last quarter hour. */
	async getTicket(): Promise<PveTicket> {
		const cached = this.currentTicket
		if (cached && Date.now() < cached.expiresAt - TICKET_RENEW_MARGIN_MS) return cached
		return this.authenticate()
	}

	/**
	 * Discards the cached ticket and logs in with the password again.
	 *
	 * A renewal already in flight is carrying the ticket being discarded, so its
	 * answer cannot settle whether that ticket was the problem. This waits for it
	 * to land, which also keeps it from writing its result over the fresh one,
	 * and only then logs in.
	 */
	async forceRefresh(): Promise<PveTicket> {
		const inFlight = this.pending
		if (inFlight) await inFlight.catch(() => undefined)
		this.currentTicket = undefined
		return this.authenticate()
	}

	/**
	 * Logs in, or renews. PVE accepts a still-valid ticket in place of the
	 * password, which renews without sending the password again. Concurrent
	 * callers share the request in flight.
	 */
	async authenticate(): Promise<PveTicket> {
		if (this.pending) return this.pending
		this.pending = this.login().finally(() => {
			this.pending = undefined
		})
		return this.pending
	}

	private async login(): Promise<PveTicket> {
		const credential = this.ticketCredential
		if (!credential) {
			throw new PveConfigError(
				'No ticket credentials. Set PVE_USER and PVE_PASSWORD to use ticket authentication.',
			)
		}

		const cached = this.currentTicket
		if (cached) {
			const renewed = await this.postTicket(credential.username, cached.ticket)
			if (renewed.ok) return this.cache(renewed.payload, credential.username)
			// The server let the ticket die early; the password is still at hand.
			this.currentTicket = undefined
		}

		const fresh = await this.postTicket(credential.username, credential.password)
		if (!fresh.ok) throw new PveAuthError('ticket', fresh.detail)
		return this.cache(fresh.payload, credential.username)
	}

	/**
	 * One POST /access/ticket. A rejected login comes back as a result, not a
	 * throw. The detail keeps the status and the envelope message; the rest of
	 * the body could be a proxy page echoing the request.
	 */
	private async postTicket(username: string, password: string): Promise<LoginResult> {
		const resp = await this.http.request(`${this.baseUrl}/api2/json/access/ticket`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ username, password }).toString(),
			verifySsl: this.connection.verifySsl,
		})
		if (!resp.ok) {
			const message = envelopeMessage(await resp.text())
			return { ok: false, detail: `HTTP ${resp.status}${message ? ` ${message}` : ''}` }
		}
		let parsed: unknown
		try {
			parsed = await resp.json()
		} catch (error) {
			if (error instanceof PveApiError) throw new PveAuthError('ticket', error.message)
			throw error
		}
		const payload = readTicketPayload(parsed)
		if (!payload) throw new PveAuthError('ticket', 'the response carried no ticket')
		return { ok: true, payload }
	}

	private cache(payload: TicketPayload, fallbackUsername: string): PveTicket {
		this.currentTicket = {
			ticket: payload.ticket,
			csrfToken: payload.csrfToken,
			username: payload.username ?? fallbackUsername,
			expiresAt: Date.now() + TICKET_LIFETIME_MS,
		}
		return this.currentTicket
	}

	/** Drops the cached ticket. Safe to call more than once. */
	destroy(): void {
		this.currentTicket = undefined
	}
}

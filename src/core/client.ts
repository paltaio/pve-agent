/**
 * The API client every other module is built on.
 *
 * One instance owns its credentials, its HTTP client and its ticket, so
 * several clients can talk to several clusters in one process.
 *
 * Each call is looked up in the generated endpoint registry, which decides the
 * credential it needs. Almost everything runs on the API token; the calls PVE
 * restricts to root@pam switch to the login ticket on their own. When the
 * needed credential is absent the client says so before sending the request,
 * instead of letting the node answer 403.
 */

import { PveAuth, loadCredentials, type CredentialInput, type PveCredentials } from './auth.ts'
import {
	PveApiError,
	PveAuthError,
	PveConfigError,
	PveNotFoundError,
	PvePermissionError,
	PveTierError,
	type AuthTier,
} from './errors.ts'
import {
	HttpClient,
	type HttpBody,
	type HttpClientOptions,
	type HttpRequestOptions,
} from './http.ts'
import { rootOnlyParams, type RootOnlyParamHit } from './privileges.ts'
import { resolveEndpoint } from './schema.ts'
import {
	getTaskLog,
	getTaskStatus,
	waitForTask,
	type TaskLogOptions,
	type TaskStatus,
	type WaitOptions,
} from './tasks.ts'
import type { EndpointInfo } from '../generated/endpoints.ts'

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE'

/**
 * Parameters for one call.
 *
 * Any object is accepted, including the generated parameter interfaces. An
 * interface gets no implicit index signature, so a record type here would
 * reject every one of them at the call site. The values are read back as
 * unknown and checked by encodeParams.
 */
export type PveParams = object

/** What the client decided about credentials for one call, and why. */
export interface TierDecision {
	tier: AuthTier
	reason: string
	/** True when the ticket has to belong to root@pam, not just any user. */
	requiresRootPam: boolean
	endpoint: EndpointInfo | undefined
	rootOnlyParams: readonly RootOnlyParamHit[]
}

/** Emitted for every attempt, before it goes out. */
export interface RequestTrace {
	method: HttpMethod
	/** The concrete path, with variables filled in. */
	path: string
	/** The registry path template, when the endpoint is known. */
	endpointPath: string | undefined
	decision: TierDecision
	/** True when a token was available and the call went out on the ticket instead. */
	escalated: boolean
	attempt: number
}

export interface PveClientOptions {
	credentials: PveCredentials
	/** Abort a request that produces no response within this many milliseconds. */
	timeoutMs?: number
	/** Called before each attempt. Makes tier choices and escalations visible. */
	onRequest?: (trace: RequestTrace) => void
}

export interface RequestOptions {
	/** Use this tier instead of the one the registry implies. */
	tier?: AuthTier
	headers?: Record<string, string>
	signal?: AbortSignal
	/**
	 * Send the request even when the path is not in the registry. Without this,
	 * an unknown path is an error, which catches typos.
	 */
	allowUnknownEndpoint?: boolean
	/**
	 * Send this instead of form-encoding `params`. A FormData body carries its
	 * own Content-Type, which is how a storage upload goes out. `params` on a
	 * POST or PUT would be dropped, so passing both is an error.
	 */
	body?: HttpBody
	/**
	 * Return the keys the handler set beside `data` as well as `data` itself.
	 * A handful of read endpoints report `total` or `changes` that way.
	 */
	withAttribs?: boolean
}

/** `data` plus the keys a handler set next to it in the JSON envelope. */
export interface EnvelopeResult<T> {
	data: T
	/** Keys the handler set beside `data`, such as `total` and `changes`. */
	attribs: Readonly<Record<string, unknown>>
}

/** A URL and the headers that authenticate it, for a response that is not JSON. */
export interface SignedRequest {
	url: string
	headers: Record<string, string>
}

/** The parts of a response the envelope reader needs. */
export interface RawResponse {
	status: number
	ok: boolean
	body: string
}

/**
 * PVE takes parameters as form fields. Booleans go over as 1 and 0, an array
 * parameter repeats its key once per element, and undefined or null is left
 * out.
 */
export function encodeParams(params: PveParams): URLSearchParams {
	const search = new URLSearchParams()
	const entries: [string, unknown][] = Object.entries(params)
	for (const [key, value] of entries) {
		if (value === undefined || value === null) continue
		if (Array.isArray(value)) {
			for (const item of value) search.append(key, encodeScalar(key, item))
			continue
		}
		search.append(key, encodeScalar(key, value))
	}
	return search
}

function encodeScalar(key: string, value: unknown): string {
	if (typeof value === 'boolean') return value ? '1' : '0'
	if (typeof value === 'string') return value
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) {
			throw new PveConfigError(`Parameter '${key}' is ${value}, which the API cannot take`)
		}
		return String(value)
	}
	throw new PveConfigError(
		`Parameter '${key}' is a ${typeof value}. Pass a string, number, boolean, or an array of those; property strings are built with formatPropertyString.`,
	)
}

function appendQuery(path: string, query: string): string {
	if (!query) return path
	return `${path}${path.includes('?') ? '&' : '?'}${query}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const MISSING_OBJECT = /does not exist|no such|not found|unable to find/i

interface Envelope {
	data: unknown
	attribs: Record<string, unknown>
	message: string | undefined
	errors: Record<string, string> | undefined
}

/** The JSON envelope, or undefined when the body is not a JSON object. */
function readEnvelope(body: string): Envelope | undefined {
	let parsed: unknown
	try {
		parsed = JSON.parse(body)
	} catch {
		return undefined
	}
	if (!isRecord(parsed)) return undefined
	const attribs: Record<string, unknown> = {}
	for (const [key, value] of Object.entries(parsed)) {
		if (key !== 'data') attribs[key] = value
	}
	const message = parsed['message']
	let errors: Record<string, string> | undefined
	if (isRecord(parsed['errors'])) {
		errors = {}
		for (const [key, value] of Object.entries(parsed['errors'])) {
			if (typeof value === 'string') errors[key] = value
		}
	}
	return {
		data: parsed['data'],
		attribs,
		message: typeof message === 'string' ? message : undefined,
		errors,
	}
}

/**
 * Turns one raw response into its `data` and sibling keys, or into the error
 * class that matches its status. A 2xx with an empty body, or an envelope
 * without `data`, has undefined data.
 */
function settleResponse<T>(
	method: HttpMethod,
	path: string,
	tier: AuthTier,
	response: RawResponse,
): EnvelopeResult<T> {
	const envelope = readEnvelope(response.body)

	if (response.ok) {
		// A proxy in front of the node answers 200 with its own error page.
		// Handing the caller undefined would move the failure to wherever the
		// value is first used, which no longer names the API.
		if (!envelope && response.body.trim() !== '') {
			throw new PveApiError({
				status: response.status,
				method,
				path,
				detail: `the response is not JSON: ${response.body.trim().slice(0, 300)}`,
			})
		}
		// The envelope is untyped; the caller's T is a promise about the endpoint.
		return { data: envelope?.data as T, attribs: envelope?.attribs ?? {} }
	}

	const detail =
		envelope?.message?.trim() || response.body.trim().slice(0, 500) || 'no response body'

	if (response.status === 401) throw new PveAuthError(tier, detail)
	if (response.status === 403) throw new PvePermissionError({ method, path, tier, detail })
	// A missing guest, storage or config file comes back as a 500 whose message
	// names what was not there, so the class follows the message.
	if (
		response.status === 404 ||
		response.status === 501 ||
		(response.status === 500 && MISSING_OBJECT.test(detail))
	) {
		throw new PveNotFoundError({ method, path, detail })
	}
	throw new PveApiError({
		status: response.status,
		method,
		path,
		detail,
		...(envelope?.errors ? { errors: envelope.errors } : {}),
	})
}

/** The `data` field of one raw response, or the error class that matches its status. */
export function unwrapEnvelope<T>(
	method: HttpMethod,
	path: string,
	tier: AuthTier,
	response: RawResponse,
): T {
	return settleResponse<T>(method, path, tier, response).data
}

export class PveClient {
	readonly auth: PveAuth
	readonly http: HttpClient

	private readonly onRequest: ((trace: RequestTrace) => void) | undefined

	constructor(options: PveClientOptions) {
		const httpOptions: HttpClientOptions = { verifySsl: options.credentials.connection.verifySsl }
		if (options.timeoutMs !== undefined) httpOptions.timeoutMs = options.timeoutMs
		this.http = new HttpClient(httpOptions)
		this.auth = new PveAuth(options.credentials, this.http)
		this.onRequest = options.onRequest
	}

	/** Builds a client from explicit values, the environment, and a pve.env file. */
	static fromEnv(
		input: CredentialInput & { timeoutMs?: number; onRequest?: (trace: RequestTrace) => void } = {},
	): PveClient {
		const { timeoutMs, onRequest, ...credentialInput } = input
		const options: PveClientOptions = { credentials: loadCredentials(credentialInput) }
		if (timeoutMs !== undefined) options.timeoutMs = timeoutMs
		if (onRequest !== undefined) options.onRequest = onRequest
		return new PveClient(options)
	}

	get baseUrl(): string {
		return this.auth.baseUrl
	}

	/** Node used when a caller does not name one, from PVE_NODE or the config. */
	get defaultNode(): string | undefined {
		return this.auth.connection.node
	}

	/** Registry entry for a concrete path, or undefined when the path is unknown. */
	endpointFor(method: HttpMethod, path: string): EndpointInfo | undefined {
		return resolveEndpoint(method, path)
	}

	/** The credential this call would use, and why. Sends nothing. */
	requiredTier(method: HttpMethod, path: string, params?: PveParams): TierDecision {
		const endpoint = resolveEndpoint(method, path)
		const hits = endpoint ? rootOnlyParams(method, endpoint.path, params) : []
		const [firstHit] = hits
		const decide = (tier: AuthTier, reason: string, requiresRootPam: boolean): TierDecision => ({
			tier,
			reason,
			requiresRootPam,
			endpoint,
			rootOnlyParams: hits,
		})

		if (endpoint?.rootOnly) {
			return decide(
				'ticket',
				'the handler compares the caller against root@pam, so an API token cannot pass',
				true,
			)
		}
		if (firstHit) {
			return decide(
				'ticket',
				`parameter '${firstHit.param}' needs root@pam: ${firstHit.reason}`,
				true,
			)
		}
		if (endpoint && !endpoint.allowToken) {
			return decide('ticket', 'the endpoint is registered with allowtoken 0', false)
		}
		if (this.auth.has('token')) {
			return decide('token', 'an API token reaches this endpoint', false)
		}
		return decide('ticket', 'no API token is configured', false)
	}

	async get<T>(path: string, params?: PveParams, options?: RequestOptions): Promise<T> {
		return this.request<T>('GET', path, params, options)
	}

	async post<T>(path: string, params?: PveParams, options?: RequestOptions): Promise<T> {
		return this.request<T>('POST', path, params, options)
	}

	async put<T>(path: string, params?: PveParams, options?: RequestOptions): Promise<T> {
		return this.request<T>('PUT', path, params, options)
	}

	async delete<T>(path: string, params?: PveParams, options?: RequestOptions): Promise<T> {
		return this.request<T>('DELETE', path, params, options)
	}

	/**
	 * Send one API call and return the `data` field of the response.
	 *
	 * `path` is the concrete path below /api2/json, with variables already filled
	 * in, such as `/nodes/ms01/qemu/100/config`. With `withAttribs` the call
	 * returns the sibling keys of `data` alongside it instead.
	 */
	request<T>(
		method: HttpMethod,
		path: string,
		params: PveParams | undefined,
		options: RequestOptions & { withAttribs: true },
	): Promise<EnvelopeResult<T>>
	request<T>(
		method: HttpMethod,
		path: string,
		params?: PveParams,
		options?: RequestOptions,
	): Promise<T>
	async request<T>(
		method: HttpMethod,
		path: string,
		params?: PveParams,
		options: RequestOptions = {},
	): Promise<T | EnvelopeResult<T>> {
		const decision = this.resolveDecision(method, path, params, options)

		let response = await this.attempt(method, path, params, options, decision, 1)
		if (response.status === 403 && decision.tier === 'ticket') {
			// A ticket can go stale when roles change while it is cached. One fresh login
			// separates a stale ticket from a real permission problem.
			await this.auth.forceRefresh()
			response = await this.attempt(method, path, params, options, decision, 2)
		}

		const envelope = settleResponse<T>(method, path, decision.tier, response)
		return options.withAttribs ? envelope : envelope.data
	}

	/**
	 * The URL and auth headers for one call, without sending it.
	 *
	 * For an endpoint whose answer is not JSON, such as a file-restore download:
	 * the tier decision, the registry check and the credential are the same ones
	 * `request` would use, and the caller fetches the URL itself.
	 */
	async signRequest(
		method: HttpMethod,
		path: string,
		params?: PveParams,
		options: RequestOptions = {},
	): Promise<SignedRequest> {
		const decision = this.resolveDecision(method, path, params, options)
		const headers = await this.authHeaders(method, decision)
		Object.assign(headers, options.headers)
		const query = params ? encodeParams(params).toString() : ''
		return { url: `${this.baseUrl}/api2/json${appendQuery(path, query)}`, headers }
	}

	async taskStatus(upid: string): Promise<TaskStatus> {
		return getTaskStatus(this, upid)
	}

	/** Waits for a worker task and throws PveTaskError with its exit status. */
	async waitForTask(upid: string, options?: WaitOptions): Promise<TaskStatus> {
		return waitForTask(this, upid, options)
	}

	/** Lines of a task log, oldest first. The whole log unless a limit is given. */
	async taskLog(upid: string, options?: TaskLogOptions): Promise<string[]> {
		return getTaskLog(this, upid, options)
	}

	/** Releases pooled sockets and drops the cached ticket. */
	close(): void {
		this.auth.destroy()
		this.http.close()
	}

	private resolveDecision(
		method: HttpMethod,
		path: string,
		params: PveParams | undefined,
		options: RequestOptions,
	): TierDecision {
		const decision = this.requiredTier(method, path, params)

		if (!decision.endpoint && !options.allowUnknownEndpoint) {
			throw new PveNotFoundError({
				method,
				path,
				detail:
					'no endpoint with this path is in the generated registry. Check the path, or pass { allowUnknownEndpoint: true } for a path the schema dump does not carry',
			})
		}

		const forced = options.tier !== undefined && options.tier !== decision.tier
		const effective: TierDecision = forced
			? {
					...decision,
					tier: options.tier ?? decision.tier,
					reason: 'the caller asked for this tier',
				}
			: decision

		if (!this.auth.has(effective.tier)) {
			throw new PveTierError({
				required: effective.tier,
				available: this.auth.tiers,
				method,
				path,
				reason: effective.reason,
			})
		}
		if (effective.requiresRootPam && !forced && !this.auth.hasRootTicket) {
			throw new PveTierError({
				required: 'ticket',
				available: this.auth.tiers,
				method,
				path,
				reason: `${effective.reason}; the configured ticket user is ${
					this.auth.ticketUsername ?? 'unset'
				}`,
			})
		}
		return effective
	}

	/** Accept plus the credential the decision picked, with CSRF on ticket writes. */
	private async authHeaders(
		method: HttpMethod,
		decision: TierDecision,
	): Promise<Record<string, string>> {
		const headers: Record<string, string> = { Accept: 'application/json' }
		if (decision.tier === 'token') {
			headers['Authorization'] = this.auth.tokenHeader()
			return headers
		}
		const ticket = await this.auth.getTicket()
		headers['Cookie'] = `PVEAuthCookie=${encodeURIComponent(ticket.ticket)}`
		if (method !== 'GET') headers['CSRFPreventionToken'] = ticket.csrfToken
		return headers
	}

	private async attempt(
		method: HttpMethod,
		path: string,
		params: PveParams | undefined,
		options: RequestOptions,
		decision: TierDecision,
		attempt: number,
	): Promise<RawResponse> {
		this.onRequest?.({
			method,
			path,
			endpointPath: decision.endpoint?.path,
			decision,
			escalated: decision.tier === 'ticket' && this.auth.has('token'),
			attempt,
		})

		const headers = await this.authHeaders(method, decision)
		Object.assign(headers, options.headers)

		const encoded = params ? encodeParams(params) : new URLSearchParams()
		// The API server refuses a DELETE that carries a body with "Unexpected
		// content for method 'DELETE'", so GET and DELETE both put their
		// parameters in the query string.
		const inQuery = method === 'GET' || method === 'DELETE'
		const url = `${this.baseUrl}/api2/json${appendQuery(path, inQuery ? encoded.toString() : '')}`
		let body = options.body
		if (!inQuery && encoded.size > 0) {
			if (body !== undefined) {
				throw new PveConfigError(
					`${method} ${path} was given both a body and parameters; fold the parameters into the body`,
				)
			}
			headers['Content-Type'] = 'application/x-www-form-urlencoded'
			body = encoded.toString()
		}

		const requestOptions: HttpRequestOptions = { method, headers }
		if (body !== undefined) requestOptions.body = body
		if (options.signal) requestOptions.signal = options.signal

		const response = await this.http.request(url, requestOptions)
		return { status: response.status, ok: response.ok, body: await response.text() }
	}
}

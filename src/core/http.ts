/**
 * Fetch wrapper that owns the TLS setting for one client.
 *
 * The setting travels with each request as a fetch option. Nothing here
 * touches process-wide TLS state, so clients with different settings coexist
 * in one process.
 */

import { PveApiError, PveConnectionError } from './errors.ts'

export type HttpBody =
	| string
	| ArrayBuffer
	| ArrayBufferView
	| Blob
	| FormData
	| URLSearchParams
	| ReadableStream<Uint8Array>

export interface HttpRequestOptions {
	method?: string
	headers?: Record<string, string>
	/**
	 * A FormData body has its Content-Type set by the runtime, so any
	 * Content-Type passed alongside one is dropped: writing the header by hand
	 * loses the multipart boundary and the node cannot parse the upload.
	 */
	body?: HttpBody
	signal?: AbortSignal
	/** Overrides the client default for this one request. */
	verifySsl?: boolean
}

export interface HttpResponse {
	status: number
	ok: boolean
	headers: Headers
	text(): Promise<string>
	/** The parsed body; a body that is not JSON throws PveApiError. */
	json(): Promise<unknown>
}

export interface HttpClientOptions {
	/** Verify the node's TLS certificate. Homelab nodes usually need false. */
	verifySsl?: boolean
	/** Abort a request that produces no response within this many milliseconds. */
	timeoutMs?: number
}

/** Fetch takes concrete typed arrays; any other view is re-viewed as bytes over the same memory. */
function toBodyInit(body: HttpBody | undefined): Bun.BodyInit | undefined {
	if (body === undefined || !ArrayBuffer.isView(body)) return body
	return new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
}

function stripBoundaryHeader(
	headers: Record<string, string> | undefined,
	body: HttpBody | undefined,
): Record<string, string> | undefined {
	if (!headers || !(body instanceof FormData)) return headers
	const kept: Record<string, string> = {}
	for (const [name, value] of Object.entries(headers)) {
		if (name.toLowerCase() !== 'content-type') kept[name] = value
	}
	return kept
}

export class HttpClient {
	readonly verifySsl: boolean
	readonly timeoutMs: number

	constructor(options: HttpClientOptions = {}) {
		this.verifySsl = options.verifySsl ?? true
		this.timeoutMs = options.timeoutMs ?? 60_000
	}

	async request(url: string, options: HttpRequestOptions = {}): Promise<HttpResponse> {
		const timeout = AbortSignal.timeout(this.timeoutMs)
		const init: BunFetchRequestInit = {
			method: options.method ?? 'GET',
			headers: stripBoundaryHeader(options.headers, options.body),
			body: toBodyInit(options.body),
			signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
			tls: { rejectUnauthorized: options.verifySsl ?? this.verifySsl },
		}

		// The body is read here rather than handed back as a closure: a reset or a
		// timeout during the read happens after the headers land, and the caller
		// awaiting it outside this method would see a raw runtime error.
		let resp: Response
		let body: string
		try {
			resp = await fetch(url, init)
			body = await resp.text()
		} catch (cause) {
			// A caller who cancelled asked for this; only a failure it did not ask
			// for points at the connection.
			if (options.signal?.aborted) throw options.signal.reason
			throw new PveConnectionError(url, cause)
		}

		return {
			status: resp.status,
			ok: resp.ok,
			headers: resp.headers,
			text: async () => body,
			json: async () => parseJson(body, resp.status, init.method ?? 'GET', url),
		}
	}

	/** Bun's fetch pools sockets process-wide, so there is nothing to release per client. */
	close(): void {}
}

function parseJson(body: string, status: number, method: string, url: string): unknown {
	try {
		return JSON.parse(body)
	} catch {
		throw new PveApiError({
			status,
			method,
			path: new URL(url).pathname,
			detail: `the response is not JSON: ${body.trim().slice(0, 300) || 'empty body'}`,
		})
	}
}

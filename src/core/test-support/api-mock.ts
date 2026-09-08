/**
 * A fake PVE API for tests: a TLS server that records every request and
 * answers from a queue of scripted replies.
 *
 * The client, the endpoint registry, the parameter encoding and the ticket
 * login all run for real against it, so a test can assert the exact method,
 * URL, headers and body a call produces. `POST /access/ticket` is answered by
 * the server itself; everything else takes the next queued reply.
 *
 * The certificate is generated once per process with openssl, which has to be
 * on PATH.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PveClient, type RequestTrace } from '../client.ts'

export interface RecordedRequest {
	method: string
	url: string
	/** Path below /api2/json, query string included. */
	path: string
	query: URLSearchParams
	/** Header names in lower case, as the server received them. */
	headers: Record<string, string>
	/** The request body as text; empty when there was none or it was multipart. */
	body: string
	/** The parts of a multipart upload, keyed by field name. */
	form: Record<string, MultipartField> | undefined
}

export interface MultipartField {
	/** The part's content as text. */
	text: string
	/** Set when the part was a file. */
	filename: string | undefined
}

export interface MockReply {
	status?: number
	/** Placed in the envelope's `data` field. */
	data?: unknown
	/** Extra envelope keys beside `data`, such as `total` and `changes`. */
	attribs?: Record<string, unknown>
	/** Sent instead of a generated envelope. */
	body?: string
	/** Hold the response this long before sending it. */
	delayMs?: number
}

export interface MockClientOptions {
	/** Give the client an API token. Defaults to true. */
	token?: boolean
	/** The user the ticket credential logs in as. Defaults to root@pam; false leaves the ticket out. */
	ticket?: string | false
	onRequest?: (trace: RequestTrace) => void
	timeoutMs?: number
}

export interface MockClient {
	client: PveClient
	/** Every request the server received, logins included. */
	requests: RecordedRequest[]
	/** Queues one reply. Replies are used in order; the default is `data: null`. */
	reply(reply: MockReply): void
	last(): RecordedRequest
	/** Requests other than ticket logins. */
	calls(): RecordedRequest[]
	close(): void
}

const TICKET_PATH = '/api2/json/access/ticket'

let tls: { key: string; cert: string } | undefined

/** A self-signed localhost certificate for this process. */
function serverTls(): { key: string; cert: string } {
	if (tls) return tls
	const dir = mkdtempSync(join(tmpdir(), 'pve-agent-mock-'))
	try {
		const keyPath = join(dir, 'key.pem')
		const certPath = join(dir, 'cert.pem')
		const result = Bun.spawnSync(
			[
				'openssl',
				'req',
				'-x509',
				'-newkey',
				'ec',
				'-pkeyopt',
				'ec_paramgen_curve:prime256v1',
				'-nodes',
				'-keyout',
				keyPath,
				'-out',
				certPath,
				'-days',
				'1',
				'-subj',
				'/CN=localhost',
			],
			{ stdout: 'ignore', stderr: 'pipe' },
		)
		if (result.exitCode !== 0) {
			throw new Error(`openssl could not create the test certificate: ${result.stderr.toString()}`)
		}
		tls = { key: readFileSync(keyPath, 'utf8'), cert: readFileSync(certPath, 'utf8') }
		return tls
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
}

const open = new Set<MockClient>()

/** Starts a fake API and a client pointed at it. Call `close()` when done, or register closeMockClients in afterEach. */
export function mockClient(options: MockClientOptions = {}): MockClient {
	const requests: RecordedRequest[] = []
	const replies: MockReply[] = []

	const server = Bun.serve({
		port: 0,
		hostname: '127.0.0.1',
		tls: serverTls(),
		async fetch(req) {
			const url = new URL(req.url)
			const recorded: RecordedRequest = {
				method: req.method,
				url: req.url,
				path: `${url.pathname.replace(/^\/api2\/json/, '')}${url.search}`,
				query: url.searchParams,
				headers: req.headers.toJSON(),
				body: '',
				form: undefined,
			}
			if ((req.headers.get('content-type') ?? '').startsWith('multipart/form-data')) {
				recorded.form = {}
				for (const [name, value] of await req.formData()) {
					recorded.form[name] =
						typeof value === 'string'
							? { text: value, filename: undefined }
							: { text: await value.text(), filename: value.name }
				}
			} else {
				recorded.body = await req.text()
			}
			requests.push(recorded)

			if (url.pathname === TICKET_PATH) {
				const username = new URLSearchParams(recorded.body).get('username') ?? ''
				return Response.json({
					data: { ticket: `PVE:${username}:TICKET`, CSRFPreventionToken: 'CSRF', username },
				})
			}

			const reply = replies.shift() ?? { data: null }
			if (reply.delayMs !== undefined) await Bun.sleep(reply.delayMs)
			const status = reply.status ?? 200
			if (reply.body !== undefined) return new Response(reply.body, { status })
			return Response.json({ data: reply.data ?? null, ...reply.attribs }, { status })
		},
	})

	const client = new PveClient({
		...(options.onRequest ? { onRequest: options.onRequest } : {}),
		...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
		credentials: {
			connection: { host: '127.0.0.1', port: server.port ?? 0, verifySsl: false },
			...(options.token === false ? {} : { token: { id: 'agents@pve!ci', secret: 'secret' } }),
			...(options.ticket === false
				? {}
				: { ticket: { username: options.ticket ?? 'root@pam', password: 'password' } }),
		},
	})

	const mock: MockClient = {
		client,
		requests,
		reply: (reply) => {
			replies.push(reply)
		},
		last: () => {
			const entry = requests.at(-1)
			if (!entry) throw new Error('the fake API received no request')
			return entry
		},
		calls: () => requests.filter((entry) => entry.path !== '/access/ticket'),
		close: () => {
			open.delete(mock)
			client.close()
			server.stop(true)
		},
	}
	open.add(mock)
	return mock
}

/** Closes every mock still open. Register it with afterEach. */
export function closeMockClients(): void {
	for (const mock of open) mock.close()
}

/** The parsed fields of a form request. Fails when the body is not one. */
export function formFields(request: RecordedRequest): URLSearchParams {
	const type = request.headers['content-type'] ?? ''
	if (!type.startsWith('application/x-www-form-urlencoded')) {
		throw new Error(`${request.method} ${request.path} sent no form body`)
	}
	return new URLSearchParams(request.body)
}

/** The form fields as a plain object, for asserting a whole body at once. */
export function formObject(request: RecordedRequest): Record<string, string> {
	return Object.fromEntries(formFields(request))
}

/** The parts of an upload. Fails when the body is not multipart. */
export function multipart(request: RecordedRequest): Record<string, MultipartField> {
	if (!request.form) throw new Error(`${request.method} ${request.path} sent no multipart body`)
	return request.form
}

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { PveConnectionError } from './errors.ts'
import { HttpClient } from './http.ts'

interface Seen {
	method: string
	path: string
	headers: Record<string, string>
	body: string
	form?: Record<string, string>
}

let server: ReturnType<typeof Bun.serve>
let base: string
const seen: Seen[] = []

beforeAll(() => {
	server = Bun.serve({
		port: 0,
		hostname: '127.0.0.1',
		async fetch(req) {
			const url = new URL(req.url)
			if (url.pathname === '/hang') {
				await new Promise(() => {})
			}
			if (url.pathname === '/status') {
				return new Response('nope', { status: 403, headers: { 'X-Reason': 'denied' } })
			}
			const entry: Seen = {
				method: req.method,
				path: url.pathname + url.search,
				headers: req.headers.toJSON(),
				body: '',
			}
			const type = req.headers.get('content-type') ?? ''
			if (type.startsWith('multipart/form-data')) {
				const form = await req.formData()
				entry.form = {}
				for (const [name, value] of form) {
					entry.form[name] = typeof value === 'string' ? value : await value.text()
				}
			} else {
				entry.body = await req.text()
			}
			seen.push(entry)
			return Response.json({ data: { ok: true } })
		},
	})
	base = server.url.origin
})

afterAll(async () => {
	await server.stop(true)
})

function last(): Seen {
	const entry = seen.at(-1)
	if (!entry) throw new Error('no request recorded')
	return entry
}

describe('HttpClient requests', () => {
	test('defaults to GET and passes headers through', async () => {
		const http = new HttpClient()
		const resp = await http.request(`${base}/api2/json/version?x=1`, {
			headers: { Authorization: 'PVEAPIToken=a@pve!ci=secret' },
		})
		expect(resp.status).toBe(200)
		expect(resp.ok).toBe(true)
		expect(last().method).toBe('GET')
		expect(last().path).toBe('/api2/json/version?x=1')
		expect(last().headers['authorization']).toBe('PVEAPIToken=a@pve!ci=secret')
		http.close()
	})

	test('a string body keeps the Content-Type the caller set', async () => {
		const http = new HttpClient()
		await http.request(`${base}/x`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: 'a=1&b=2',
		})
		expect(last().method).toBe('POST')
		expect(last().headers['content-type']).toBe('application/x-www-form-urlencoded')
		expect(last().body).toBe('a=1&b=2')
		http.close()
	})

	test('a URLSearchParams body is sent form-encoded', async () => {
		const http = new HttpClient()
		await http.request(`${base}/x`, {
			method: 'PUT',
			body: new URLSearchParams({ name: 'vm 1', cores: '2' }),
		})
		expect(last().method).toBe('PUT')
		expect(last().headers['content-type']).toStartWith('application/x-www-form-urlencoded')
		expect(last().body).toBe('name=vm+1&cores=2')
		http.close()
	})

	test('a typed array body arrives byte for byte', async () => {
		const http = new HttpClient()
		const bytes = new Uint8Array([0x70, 0x76, 0x65, 0x00, 0xff])
		await http.request(`${base}/x`, { method: 'POST', body: bytes.subarray(0, 3) })
		expect(last().body).toBe('pve')
		http.close()
	})

	// The multipart boundary lives in the Content-Type the runtime generates, so
	// a header written by hand would make the upload unparseable.
	test('a FormData body loses a Content-Type the caller set', async () => {
		const http = new HttpClient()
		const form = new FormData()
		form.append('content', 'iso')
		form.append('filename', new Blob(['payload']), 'disk.iso')
		await http.request(`${base}/upload`, {
			method: 'POST',
			headers: { 'Content-Type': 'multipart/form-data', Accept: 'application/json' },
			body: form,
		})
		expect(last().headers['content-type']).toMatch(/^multipart\/form-data; boundary=/)
		expect(last().headers['accept']).toBe('application/json')
		expect(last().form).toEqual({ content: 'iso', filename: 'payload' })
		http.close()
	})
})

describe('HttpClient responses', () => {
	test('exposes status, headers and both body readers', async () => {
		const http = new HttpClient()
		const resp = await http.request(`${base}/status`)
		expect(resp.status).toBe(403)
		expect(resp.ok).toBe(false)
		expect(resp.headers.get('x-reason')).toBe('denied')
		expect(await resp.text()).toBe('nope')
		expect(await resp.text()).toBe('nope')
		await expect(resp.json()).rejects.toThrow(SyntaxError)
		http.close()
	})

	test('parses a JSON body', async () => {
		const http = new HttpClient()
		const resp = await http.request(`${base}/x`)
		expect(await resp.json()).toEqual({ data: { ok: true } })
		http.close()
	})
})

describe('HttpClient failures', () => {
	test('a timeout becomes a PveConnectionError', async () => {
		const http = new HttpClient({ timeoutMs: 50 })
		const error = await http.request(`${base}/hang`).catch((e: unknown) => e)
		expect(error).toBeInstanceOf(PveConnectionError)
		if (!(error instanceof PveConnectionError)) return
		expect(error.url).toBe(`${base}/hang`)
		http.close()
	})

	test('a refused connection becomes a PveConnectionError carrying the url', async () => {
		const idle = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') })
		const url = `${idle.url.origin}/api2/json/version`
		await idle.stop(true)

		const http = new HttpClient()
		const error = await http.request(url).catch((e: unknown) => e)
		expect(error).toBeInstanceOf(PveConnectionError)
		if (!(error instanceof PveConnectionError)) return
		expect(error.url).toBe(url)
		expect(error.cause).toBeDefined()
		http.close()
	})

	test('a body that dies mid-read becomes a PveConnectionError', async () => {
		// Promises 100 body bytes, sends 4, then drops the socket.
		const cut = Bun.listen({
			hostname: '127.0.0.1',
			port: 0,
			socket: {
				data(socket) {
					socket.end('HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n{"da')
				},
			},
		})
		const http = new HttpClient()
		try {
			await expect(http.request(`http://127.0.0.1:${cut.port}/x`)).rejects.toThrow(
				PveConnectionError,
			)
		} finally {
			cut.stop(true)
			http.close()
		}
	})

	test('rethrows a caller abort as itself', async () => {
		const http = new HttpClient()
		const controller = new AbortController()
		const reason = new Error('the caller stopped waiting')
		const pending = http.request(`${base}/hang`, { signal: controller.signal })
		controller.abort(reason)
		await expect(pending).rejects.toBe(reason)
		http.close()
	})
})

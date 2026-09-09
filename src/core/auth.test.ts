import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	setSystemTime,
	test,
} from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PveAuth, loadCredentials, type PveCredentials } from './auth.ts'
import { PveAuthError, PveConfigError } from './errors.ts'
import { HttpClient, type HttpRequestOptions, type HttpResponse } from './http.ts'

const PVE_KEYS = [
	'PVE_HOST',
	'PVE_PORT',
	'PVE_USER',
	'PVE_PASSWORD',
	'PVE_TOKEN_ID',
	'PVE_TOKEN_SECRET',
	'PVE_VERIFY_SSL',
	'PVE_NODE',
	'PVE_ENV_FILE',
] as const

const savedEnv = new Map(PVE_KEYS.map((key) => [key, process.env[key]]))

beforeEach(() => {
	for (const key of PVE_KEYS) delete process.env[key]
})

const tempDirs: string[] = []

afterEach(() => {
	for (const [key, value] of savedEnv) {
		if (value === undefined) delete process.env[key]
		else process.env[key] = value
	}
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function envFile(contents: string): Promise<string> {
	const dir = mkdtempSync(join(tmpdir(), 'pve-agent-'))
	tempDirs.push(dir)
	const path = join(dir, 'pve.env')
	await Bun.write(path, contents)
	return path
}

describe('loadCredentials', () => {
	test('reads a shell-style file with export, quotes and comments', async () => {
		const path = await envFile(
			[
				'# a comment',
				'',
				"export PVE_HOST='192.0.2.21'",
				'export PVE_USER="agents@pve"',
				'PVE_PASSWORD=plain',
				"export PVE_VERIFY_SSL='false'",
				'export PVE_TOKEN_ID=agents@pve!ci',
				'export PVE_TOKEN_SECRET="a\\"b"',
				'  export PVE_NODE = bad',
			].join('\n'),
		)
		const credentials = loadCredentials({ envFile: path })
		expect(credentials.connection).toEqual({ host: '192.0.2.21', port: 8006, verifySsl: false })
		expect(credentials.ticket).toEqual({ username: 'agents@pve', password: 'plain' })
		expect(credentials.token).toEqual({ id: 'agents@pve!ci', secret: 'a"b' })
	})

	test('explicit input beats the environment, which beats the file', async () => {
		const path = await envFile('PVE_HOST=from-file\nPVE_NODE=from-file\nPVE_PORT=1')
		process.env['PVE_HOST'] = 'from-env'
		process.env['PVE_PORT'] = '2'

		const fromEnv = loadCredentials({ envFile: path })
		expect(fromEnv.connection.host).toBe('from-env')
		expect(fromEnv.connection.port).toBe(2)
		expect(fromEnv.connection.node).toBe('from-file')

		const explicit = loadCredentials({ envFile: path, host: 'explicit', port: 3, node: 'n1' })
		expect(explicit.connection).toEqual({ host: 'explicit', port: 3, verifySsl: true, node: 'n1' })
	})

	test('PVE_ENV_FILE names the file when no path is passed', async () => {
		process.env['PVE_ENV_FILE'] = await envFile('PVE_HOST=named-file')
		expect(loadCredentials().connection.host).toBe('named-file')
	})

	test('verifies TLS unless something turns it off', async () => {
		const path = await envFile('PVE_HOST=h')
		expect(loadCredentials({ envFile: path }).connection.verifySsl).toBe(true)
		process.env['PVE_VERIFY_SSL'] = 'no'
		expect(loadCredentials({ envFile: path }).connection.verifySsl).toBe(false)
		expect(loadCredentials({ envFile: path, verifySsl: true }).connection.verifySsl).toBe(true)
	})

	test('rejects values it cannot read', async () => {
		const path = await envFile('PVE_HOST=h\nPVE_VERIFY_SSL=maybe')
		expect(() => loadCredentials({ envFile: path })).toThrow(/PVE_VERIFY_SSL/)
		process.env['PVE_VERIFY_SSL'] = '0'
		process.env['PVE_PORT'] = 'eight'
		expect(() => loadCredentials({ envFile: path })).toThrow(/PVE_PORT/)
	})

	test('names PVE_HOST when the host is missing', async () => {
		const empty = await envFile('')
		expect(() => loadCredentials({ envFile: empty })).toThrow(PveConfigError)
		expect(() => loadCredentials({ envFile: '/nonexistent/pve.env' })).toThrow(/PVE_HOST/)
	})

	test('leaves out a credential that is only half configured', async () => {
		const path = await envFile('PVE_HOST=h\nPVE_TOKEN_ID=agents@pve!ci\nPVE_USER=u')
		const credentials = loadCredentials({ envFile: path })
		expect(credentials.token).toBeUndefined()
		expect(credentials.ticket).toBeUndefined()
	})

	test('qualifies a bare token name with the user', async () => {
		const path = await envFile('PVE_HOST=h\nPVE_TOKEN_ID=ci\nPVE_TOKEN_SECRET=s')
		expect(() => loadCredentials({ envFile: path })).toThrow(/PVE_TOKEN_ID/)
		expect(loadCredentials({ envFile: path, username: 'agents@pve' }).token).toEqual({
			id: 'agents@pve!ci',
			secret: 's',
		})
	})
})

const connection = { host: 'node.test', port: 8006, verifySsl: false }
const token = { id: 'agents@pve!ci', secret: 's' }
const rootTicket = { username: 'root@pam', password: 'secret' }

describe('PveAuth tiers', () => {
	const http = new HttpClient()

	test('token only', async () => {
		const auth = new PveAuth({ connection, token }, http)
		expect(auth.tiers).toEqual(['token'])
		expect(auth.has('token')).toBe(true)
		expect(auth.has('ticket')).toBe(false)
		expect(auth.ticketUsername).toBeUndefined()
		expect(auth.hasRootTicket).toBe(false)
		expect(auth.tokenHeader()).toBe('PVEAPIToken=agents@pve!ci=s')
		await expect(auth.getTicket()).rejects.toThrow(PveConfigError)
	})

	test('ticket only', () => {
		const auth = new PveAuth(
			{ connection, ticket: { username: 'agents@pve', password: 'p' } },
			http,
		)
		expect(auth.tiers).toEqual(['ticket'])
		expect(auth.has('ticket')).toBe(true)
		expect(auth.ticketUsername).toBe('agents@pve')
		expect(auth.hasRootTicket).toBe(false)
		expect(() => auth.tokenHeader()).toThrow(PveConfigError)
	})

	test('both, token first', () => {
		const auth = new PveAuth({ connection, token, ticket: rootTicket }, http)
		expect(auth.tiers).toEqual(['token', 'ticket'])
		expect(auth.hasRootTicket).toBe(true)
		expect(auth.baseUrl).toBe('https://node.test:8006')
		expect(auth.verifySsl).toBe(false)
	})

	test('refuses to build with no credentials at all', () => {
		expect(() => new PveAuth({ connection }, http)).toThrow(PveConfigError)
	})
})

describe('ticket flow', () => {
	interface Login {
		username: string
		password: string
	}

	let server: ReturnType<typeof Bun.serve>
	let logins: Login[] = []
	let issued = 0
	/** Passwords the fake node accepts; a cached ticket is added as it is issued. */
	let accepted = new Set<string>()
	/** When set, the next login waits here before answering. */
	let hold: Promise<void> | undefined
	/** When true, the node answers 200 with an empty data object. */
	let emptyReply = false

	beforeAll(() => {
		server = Bun.serve({
			port: 0,
			hostname: '127.0.0.1',
			async fetch(req) {
				const url = new URL(req.url)
				if (req.method !== 'POST' || url.pathname !== '/api2/json/access/ticket') {
					return new Response('not found', { status: 404 })
				}
				const form = new URLSearchParams(await req.text())
				const login = { username: form.get('username') ?? '', password: form.get('password') ?? '' }
				logins.push(login)
				if (hold) {
					const gate = hold
					hold = undefined
					await gate
				}
				if (emptyReply) return Response.json({ data: {} })
				if (login.password === 'leak-me') {
					return new Response(`<html>bad gateway: password=${login.password}</html>`, {
						status: 502,
					})
				}
				if (login.password === 'html') return new Response('<html>ok</html>')
				if (login.username !== 'root@pam' || !accepted.has(login.password)) {
					return new Response('{"data":null}', { status: 401 })
				}
				issued += 1
				const ticket = `PVE:root@pam:${issued}`
				accepted.add(ticket)
				return Response.json({
					data: { ticket, CSRFPreventionToken: `CSRF${issued}`, username: 'root@pam' },
				})
			},
		})
	})

	afterAll(async () => {
		await server.stop(true)
	})

	beforeEach(() => {
		logins = []
		issued = 0
		accepted = new Set(['secret'])
		hold = undefined
		emptyReply = false
	})

	afterEach(() => {
		setSystemTime()
	})

	/** Routes the https://node.test:8006 base to the fake node. */
	class LocalHttp extends HttpClient {
		override request(url: string, options?: HttpRequestOptions): Promise<HttpResponse> {
			return super.request(url.replace('https://node.test:8006', server.url.origin), options)
		}
	}

	function auth(credentials: Partial<PveCredentials> = {}): PveAuth {
		return new PveAuth({ connection, ticket: rootTicket, ...credentials }, new LocalHttp())
	}

	test('logs in with the password and caches the ticket', async () => {
		const a = auth()
		const first = await a.getTicket()
		expect(first).toEqual({
			ticket: 'PVE:root@pam:1',
			csrfToken: 'CSRF1',
			username: 'root@pam',
			expiresAt: expect.any(Number),
		})
		expect(first.expiresAt - Date.now()).toBeGreaterThan(119 * 60 * 1000)
		expect(logins).toEqual([{ username: 'root@pam', password: 'secret' }])

		expect(await a.getTicket()).toBe(first)
		expect(logins).toHaveLength(1)
	})

	test('renews with the old ticket once it enters its last quarter hour', async () => {
		const a = auth()
		await a.getTicket()
		setSystemTime(new Date(Date.now() + 106 * 60 * 1000))

		const renewed = await a.getTicket()
		expect(renewed.ticket).toBe('PVE:root@pam:2')
		expect(logins[1]).toEqual({ username: 'root@pam', password: 'PVE:root@pam:1' })
	})

	test('falls back to the password when the node rejects the renewal', async () => {
		const a = auth()
		const first = await a.getTicket()
		accepted.delete(first.ticket)
		setSystemTime(new Date(Date.now() + 2 * 60 * 60 * 1000))

		const fresh = await a.getTicket()
		expect(fresh.ticket).toBe('PVE:root@pam:2')
		expect(logins.map((l) => l.password)).toEqual(['secret', 'PVE:root@pam:1', 'secret'])
	})

	test('collapses concurrent logins into one request', async () => {
		const a = auth()
		const tickets = await Promise.all([a.getTicket(), a.getTicket(), a.authenticate()])
		expect(logins).toHaveLength(1)
		expect(new Set(tickets.map((t) => t.ticket))).toEqual(new Set(['PVE:root@pam:1']))
	})

	test('forceRefresh logs in with the password instead of renewing', async () => {
		const a = auth()
		await a.getTicket()
		const forced = await a.forceRefresh()
		expect(forced.ticket).toBe('PVE:root@pam:2')
		expect(logins[1]?.password).toBe('secret')
	})

	test('forceRefresh waits out an in-flight renewal instead of joining it', async () => {
		const a = auth()
		await a.getTicket()

		let release = (): void => {}
		hold = new Promise<void>((resolve) => {
			release = resolve
		})
		const renewal = a.authenticate()
		while (logins.length < 2) await Bun.sleep(1)
		const forced = a.forceRefresh()
		release()

		expect((await renewal).ticket).toBe('PVE:root@pam:2')
		expect((await forced).ticket).toBe('PVE:root@pam:3')
		expect(logins.map((l) => l.password)).toEqual(['secret', 'PVE:root@pam:1', 'secret'])
	})

	test('destroy drops the cached ticket', async () => {
		const a = auth()
		await a.getTicket()
		a.destroy()
		a.destroy()
		expect((await a.getTicket()).ticket).toBe('PVE:root@pam:2')
		expect(logins[1]?.password).toBe('secret')
	})

	test('a rejected password login throws PveAuthError for the ticket tier', async () => {
		const a = auth({ ticket: { username: 'root@pam', password: 'wrong' } })
		const failure = await a.getTicket().catch((error: unknown) => error)
		expect(failure).toBeInstanceOf(PveAuthError)
		if (failure instanceof PveAuthError) {
			expect(failure.tier).toBe('ticket')
			expect(failure.message).toMatch(/HTTP 401\./)
		}
	})

	test('a failed login never repeats the body, which can echo the password', async () => {
		const a = auth({ ticket: { username: 'root@pam', password: 'leak-me' } })
		const failure = await a.getTicket().catch((error: unknown) => error)
		expect(failure).toBeInstanceOf(PveAuthError)
		if (failure instanceof PveAuthError) {
			expect(failure.message).toContain('HTTP 502')
			expect(failure.message).not.toContain('leak-me')
			expect(failure.message).not.toContain('html')
		}
	})

	test('a 200 that is not JSON is an auth error naming the body', async () => {
		const a = auth({ ticket: { username: 'root@pam', password: 'html' } })
		const failure = await a.getTicket().catch((error: unknown) => error)
		expect(failure).toBeInstanceOf(PveAuthError)
		if (failure instanceof PveAuthError) expect(failure.message).toContain('not JSON')
	})

	test('reports a response with no ticket in it', async () => {
		emptyReply = true
		await expect(auth().getTicket()).rejects.toThrow(/no ticket/)
	})
})

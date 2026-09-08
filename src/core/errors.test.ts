import { describe, expect, test } from 'bun:test'
import {
	GuestCommandError,
	PveApiError,
	PveAuthError,
	PveConfigError,
	PveConnectionError,
	PveConsoleError,
	PveError,
	type PveErrorKind,
	PveNotFoundError,
	PvePermissionError,
	PvePropertyError,
	PveShellError,
	PveTaskError,
	PveTierError,
	PveTimeoutError,
} from './errors.ts'

describe('PveError', () => {
	test('every class carries its kind and its own name', () => {
		const cases: [PveError, PveErrorKind][] = [
			[new PveConfigError('missing PVE_HOST'), 'config'],
			[new PveConnectionError('https://pve:8006', new Error('refused')), 'connection'],
			[new PveAuthError('token', 'invalid token'), 'auth'],
			[
				new PveTierError({
					required: 'ticket',
					available: [],
					method: 'POST',
					path: '/x',
					reason: 'root-only',
				}),
				'tier',
			],
			[
				new PvePermissionError({ method: 'GET', path: '/x', tier: 'token', detail: 'no' }),
				'permission',
			],
			[new PveNotFoundError({ method: 'GET', path: '/x', detail: 'gone' }), 'not-found'],
			[new PveApiError({ status: 500, method: 'GET', path: '/x', detail: 'boom' }), 'api'],
			[new PveTaskError({ upid: 'UPID:x', exitStatus: 'failed' }), 'task'],
			[new PveTimeoutError({ what: 'a thing', waitedMs: 1000 }), 'timeout'],
			[new PvePropertyError('bad format'), 'property'],
			[new PveConsoleError('socket died'), 'console'],
			[
				new GuestCommandError({ vmid: 1, what: 'ls', exitCode: 1, stdout: '', stderr: '' }),
				'guest-command',
			],
			[new PveShellError('transport', 'dropped'), 'shell'],
		]
		for (const [error, kind] of cases) {
			expect(error).toBeInstanceOf(PveError)
			expect(error).toBeInstanceOf(Error)
			expect(error.kind).toBe(kind)
			expect(error.name).toBe(error.constructor.name)
		}
	})

	test('keeps the cause it was given', () => {
		const cause = new Error('ECONNREFUSED')
		expect(new PveConnectionError('https://pve:8006', cause).cause).toBe(cause)
		expect(new PveConsoleError('closed', { cause }).cause).toBe(cause)
		expect(new PveShellError('transport', 'closed', { cause }).cause).toBe(cause)
		expect(new PveConfigError('x').cause).toBeUndefined()
	})
})

describe('PveConnectionError', () => {
	test('names the url and the underlying failure', () => {
		const error = new PveConnectionError('https://pve:8006', new Error('ECONNREFUSED'))
		expect(error.url).toBe('https://pve:8006')
		expect(error.message).toContain('Cannot reach https://pve:8006: ECONNREFUSED')
		expect(error.message).toContain('PVE_VERIFY_SSL')
	})

	test('stringifies a non-Error cause', () => {
		expect(new PveConnectionError('https://pve:8006', 'timeout').message).toContain(': timeout.')
	})
})

describe('PveAuthError', () => {
	test('points at the variables for the tier that failed', () => {
		const ticket = new PveAuthError('ticket', 'bad password')
		expect(ticket.tier).toBe('ticket')
		expect(ticket.message).toBe(
			'PVE rejected the ticket credentials: bad password. Check PVE_USER and PVE_PASSWORD.',
		)
		expect(new PveAuthError('token', 'x').message).toContain('PVE_TOKEN_ID and PVE_TOKEN_SECRET')
	})
})

describe('PveTierError', () => {
	test('names the missing tier and what the client holds', () => {
		const error = new PveTierError({
			required: 'ticket',
			available: ['token'],
			method: 'POST',
			path: '/nodes/pve/qemu/100/config',
			reason: 'args is root-only',
		})
		expect(error.required).toBe('ticket')
		expect(error.available).toEqual(['token'])
		expect(error.message).toBe(
			'POST /nodes/pve/qemu/100/config needs a root@pam ticket (set PVE_USER=root@pam and PVE_PASSWORD): args is root-only. Available credentials: token.',
		)
	})

	test('says none when the client holds no credential', () => {
		const error = new PveTierError({
			required: 'token',
			available: [],
			method: 'GET',
			path: '/x',
			reason: 'r',
		})
		expect(error.message).toContain('an API token (set PVE_TOKEN_ID and PVE_TOKEN_SECRET)')
		expect(error.message).toEndWith('Available credentials: none.')
	})
})

describe('PvePermissionError and PveNotFoundError', () => {
	test('carry the request and the detail', () => {
		const denied = new PvePermissionError({
			method: 'GET',
			path: '/nodes',
			tier: 'token',
			detail: 'Permission check failed',
		})
		expect(denied.method).toBe('GET')
		expect(denied.path).toBe('/nodes')
		expect(denied.tier).toBe('token')
		expect(denied.message).toStartWith(
			'GET /nodes denied for the token credential: Permission check failed.',
		)

		const missing = new PveNotFoundError({
			method: 'GET',
			path: '/nodes/x',
			detail: 'no such node',
		})
		expect(missing.method).toBe('GET')
		expect(missing.path).toBe('/nodes/x')
		expect(missing.message).toBe('GET /nodes/x not found: no such node')
	})
})

describe('PveApiError', () => {
	test('lists parameter errors when PVE sends them', () => {
		const error = new PveApiError({
			status: 400,
			method: 'POST',
			path: '/x',
			detail: 'Parameter verification failed',
			errors: { vmid: 'invalid format', name: 'too long' },
		})
		expect(error.status).toBe(400)
		expect(error.errors).toEqual({ vmid: 'invalid format', name: 'too long' })
		expect(error.message).toBe(
			'POST /x failed (400): Parameter verification failed. Parameter errors: vmid: invalid format; name: too long',
		)
	})

	test('has an empty error map otherwise', () => {
		const error = new PveApiError({ status: 500, method: 'GET', path: '/x', detail: 'boom' })
		expect(error.errors).toEqual({})
		expect(error.message).toBe('GET /x failed (500): boom.')
		expect(
			new PveApiError({ status: 500, method: 'GET', path: '/x', detail: 'boom', errors: {} })
				.message,
		).toBe('GET /x failed (500): boom.')
	})
})

describe('PveTaskError', () => {
	test('reports the exit status and the log tail', () => {
		const error = new PveTaskError({
			upid: 'UPID:pve:0001:x',
			exitStatus: 'command failed with exit code 1',
			log: ['line one', 'line two'],
		})
		expect(error.upid).toBe('UPID:pve:0001:x')
		expect(error.exitStatus).toBe('command failed with exit code 1')
		expect(error.timedOut).toBe(false)
		expect(error.log).toEqual(['line one', 'line two'])
		expect(error.message).toBe(
			'Task UPID:pve:0001:x finished with: command failed with exit code 1\nTask log tail:\nline one\nline two',
		)
	})

	test('describes a task that outlived the wait', () => {
		const error = new PveTaskError({
			upid: 'UPID:x',
			exitStatus: null,
			timedOut: true,
			detail: 'still running after 30s',
		})
		expect(error.timedOut).toBe(true)
		expect(error.exitStatus).toBeNull()
		expect(error.log).toEqual([])
		expect(error.message).toBe('Task UPID:x is still running after 30s')
	})

	test('falls back when there is neither detail nor exit status', () => {
		expect(new PveTaskError({ upid: 'UPID:x', exitStatus: null }).message).toBe(
			'Task UPID:x finished with: no exit status',
		)
	})
})

describe('PveTimeoutError', () => {
	test('rounds the wait to seconds and appends the detail', () => {
		const error = new PveTimeoutError({
			what: 'lxc 110 to be running',
			waitedMs: 30_400,
			detail: 'last status: stopped',
		})
		expect(error.what).toBe('lxc 110 to be running')
		expect(error.waitedMs).toBe(30_400)
		expect(error.message).toBe(
			'Timed out after 30s waiting for lxc 110 to be running; last status: stopped',
		)
		expect(new PveTimeoutError({ what: 'x', waitedMs: 1500 }).message).toBe(
			'Timed out after 2s waiting for x',
		)
	})
})

describe('GuestCommandError', () => {
	test('prefers stderr, then stdout, then a placeholder', () => {
		const base = { vmid: 100, what: 'apt-get update', exitCode: 100 }
		const withStderr = new GuestCommandError({ ...base, stdout: 'out', stderr: ' E: failed \n' })
		expect(withStderr.vmid).toBe(100)
		expect(withStderr.exitCode).toBe(100)
		expect(withStderr.stdout).toBe('out')
		expect(withStderr.stderr).toBe(' E: failed \n')
		expect(withStderr.message).toBe('apt-get update in guest 100 exited 100: E: failed')
		expect(new GuestCommandError({ ...base, stdout: 'only out', stderr: '' }).message).toBe(
			'apt-get update in guest 100 exited 100: only out',
		)
		expect(new GuestCommandError({ ...base, stdout: '', stderr: '  ' }).message).toBe(
			'apt-get update in guest 100 exited 100: no output',
		)
	})
})

describe('PveShellError', () => {
	test('names which shell failure it was', () => {
		const error = new PveShellError('policy', 'refused: rm -rf /')
		expect(error.kind).toBe('shell')
		expect(error.shell).toBe('policy')
		expect(error.message).toBe('refused: rm -rf /')
	})
})

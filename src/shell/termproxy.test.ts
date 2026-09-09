import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeMockClients, mockClient, type MockClient } from '../core/test-support/api-mock.ts'
import {
	PveShellCommandError,
	PveShellCredentialError,
	PveShellTimeoutError,
	PveShellTransportError,
} from './errors.ts'
import { TermproxyTransport, type TermproxyOptions } from './termproxy.ts'
import { FakePty, type FakePtyOptions } from './test-support.ts'

afterEach(closeMockClients)

const PROXY = { port: 5900, ticket: 'VNCTICKET', user: 'root@pam' }

function transportFor(
	mock: MockClient,
	pty: FakePty,
	options: Partial<TermproxyOptions> = {},
): TermproxyTransport {
	mock.reply({ data: PROXY })
	return new TermproxyTransport({
		client: mock.client,
		node: 'ms01-0160',
		connectTimeoutMs: 2000,
		socketFactory: () => pty,
		...options,
	})
}

async function openWith(
	ptyOptions: FakePtyOptions = {},
	options: Partial<TermproxyOptions> = {},
): Promise<{ pty: FakePty; transport: TermproxyTransport }> {
	const pty = new FakePty(ptyOptions)
	const transport = transportFor(mockClient(), pty, options)
	await transport.connect()
	return { pty, transport }
}

describe('credentials', () => {
	test('refuses without a root@pam ticket, before any request goes out', async () => {
		const mock = mockClient({ ticket: 'agents@pve' })
		const transport = new TermproxyTransport({
			client: mock.client,
			node: 'ms01-0160',
			socketFactory: () => new FakePty(),
		})
		const error = await transport.connect().then(
			() => undefined,
			(caught: unknown) => caught,
		)
		expect(error).toBeInstanceOf(PveShellCredentialError)
		if (error instanceof PveShellCredentialError) {
			expect(error.node).toBe('ms01-0160')
			expect(error.message).toContain('root@pam')
			expect(error.message).toContain('agents@pve')
		}
		expect(mock.requests).toHaveLength(0)
	})

	test('a login prompt instead of a shell is a credential error and closes the socket', async () => {
		const pty = new FakePty({ banner: 'ms01-0160 login: ' })
		const transport = transportFor(mockClient(), pty)
		await expect(transport.connect()).rejects.toBeInstanceOf(PveShellCredentialError)
		expect(pty.closes).toBe(1)
	})
})

describe('the websocket handshake', () => {
	test('asks for a proxy, opens the socket with the ticket cookie, logs in and resizes', async () => {
		const mock = mockClient()
		const pty = new FakePty()
		const urls: string[] = []
		const headers: Record<string, string>[] = []
		const transport = transportFor(mock, pty, {
			socketFactory: (url, options) => {
				urls.push(url)
				headers.push(options.headers)
				return pty
			},
		})
		await transport.connect()

		const call = mock.calls()[0]
		expect([call?.method, call?.path]).toEqual(['POST', '/nodes/ms01-0160/termproxy'])
		expect(call?.headers['cookie']).toContain('PVEAuthCookie=')
		expect(urls[0]).toBe(
			`wss://127.0.0.1:${new URL(mock.client.baseUrl).port}/api2/json/nodes/ms01-0160/vncwebsocket?port=5900&vncticket=VNCTICKET`,
		)
		expect(headers[0]?.['Cookie']).toBe('PVEAuthCookie=PVE%3Aroot%40pam%3ATICKET')
		expect(pty.sent[0]).toBe('root@pam:VNCTICKET\n')
		expect(pty.sent[1]).toBe('1:200:50:')
		expect(pty.sent[2]).toStartWith('0:')
		expect(pty.sent.join('')).toContain('stty -echo')
		expect(pty.commands).toEqual(['printf ready'])
		expect(transport.description).toBe(`termproxy ${mock.client.baseUrl}/nodes/ms01-0160`)
		await transport.close()
		expect(pty.closes).toBe(1)
	})

	test('a login the node never answers is a timeout and closes the socket', async () => {
		const pty = new FakePty({ answerAuth: false })
		const transport = transportFor(mockClient(), pty, { connectTimeoutMs: 100 })
		await expect(transport.connect()).rejects.toBeInstanceOf(PveShellTimeoutError)
		expect(pty.closes).toBe(1)
	})

	test('a socket that closes before login is a transport error', async () => {
		const pty = new FakePty({ answerAuth: false })
		const transport = transportFor(mockClient(), pty, { connectTimeoutMs: 1000 })
		const pending = transport.connect()
		pty.close()
		await expect(pending).rejects.toBeInstanceOf(PveShellTransportError)
	})
})

describe('run', () => {
	test('reads stdout, stderr and the exit code back out of the markers', async () => {
		const { pty, transport } = await openWith({
			reply: (command) =>
				command === 'zpool status tank'
					? { exitCode: 1, stderr: "cannot open 'tank': no such pool\r\n" }
					: { stdout: 'pool: rpool\r\n' },
		})
		const ok = await transport.run('zpool status')
		expect(ok).toMatchObject({ exitCode: 0, stdout: 'pool: rpool\n', stderr: '' })
		expect(ok.durationMs).toBeGreaterThanOrEqual(0)

		const failed = await transport.run('zpool status tank')
		expect(failed).toMatchObject({
			exitCode: 1,
			stdout: '',
			stderr: "cannot open 'tank': no such pool\n",
		})
		expect(pty.commands.slice(1)).toEqual(['zpool status', 'zpool status tank'])
		await transport.close()
	})

	test('the wrapper sends the command base64-encoded inside a subshell', async () => {
		const { pty, transport } = await openWith()
		const command = `printf '%s\\n' "one two" 'three'\nprintf done`
		await transport.run(command)
		expect(pty.commands.at(-1)).toBe(command)
		const line = pty.sent.filter((frame) => frame.includes('eval')).at(-1) ?? ''
		expect(line).toContain('( eval "$(printf %s ')
		expect(line).toContain(`2>"$__T"`)
		expect(line).not.toContain(command)
		await transport.close()
	})

	test('input goes over as base64 into the command pipe', async () => {
		const { pty, transport } = await openWith()
		await transport.run('cat', { input: 'payload\n' })
		expect(pty.inputs.at(-1)).toBe('payload\n')
		await transport.close()
	})

	test('cwd and env are folded into the decoded command', async () => {
		const { pty, transport } = await openWith()
		await transport.run('pwd', { cwd: '/etc/pve', env: { LC_ALL: 'C' } })
		expect(pty.commands.at(-1)).toBe('cd -- /etc/pve || exit $?; export LC_ALL=C\npwd')
		await transport.close()
	})

	test("the shell's echo and colour escapes are kept out of the result", async () => {
		const { transport } = await openWith({
			echo: true,
			reply: () => ({ stdout: '\u001b[0;32mactive\u001b[0m\r\nMainPID=1638\r\n' }),
		})
		const result = await transport.run('systemctl show pveproxy')
		expect(result.stdout).toBe('active\nMainPID=1638\n')
		await transport.close()
	})

	test('a multi-byte character split across frames is not corrupted', async () => {
		const { transport } = await openWith({
			reply: () => ({ stdout: 'a\u00f1o\r\n' }),
			splitBytes: 1,
		})
		expect((await transport.run('echo a\u00f1o')).stdout).toBe('a\u00f1o\n')
		await transport.close()
	})

	test('check turns a non-zero exit into an error carrying both streams', async () => {
		const { transport } = await openWith({
			reply: () => ({ exitCode: 2, stdout: 'partial\r\n', stderr: 'boom\r\n' }),
		})
		const error = await transport.run('false', { check: true }).then(
			() => undefined,
			(caught: unknown) => caught,
		)
		expect(error).toBeInstanceOf(PveShellCommandError)
		if (error instanceof PveShellCommandError) {
			expect(error.exitCode).toBe(2)
			expect(error.stdout).toBe('partial\n')
			expect(error.stderr).toBe('boom\n')
		}
		await transport.close()
	})

	test('a command longer than the pty line limit is refused with a pointer to ssh', async () => {
		const { transport } = await openWith({}, { maxCommandBytes: 300 })
		await expect(transport.run('echo '.repeat(200))).rejects.toThrow(/ssh transport/)
		await transport.close()
	})

	test('a command that never answers becomes a timeout and is interrupted', async () => {
		const { pty, transport } = await openWith({
			reply: (command) => (command === 'sleep 100' ? 'hang' : undefined),
		})
		await expect(transport.run('sleep 100', { timeoutMs: 100 })).rejects.toBeInstanceOf(
			PveShellTimeoutError,
		)
		expect(pty.sent.at(-1)).toBe('0:1:\u0003')
		await transport.close()
	})

	test('commands run one at a time in call order', async () => {
		const { pty, transport } = await openWith({ reply: (command) => ({ stdout: command }) })
		const results = await Promise.all([
			transport.run('first'),
			transport.run('second'),
			transport.run('third'),
		])
		expect(results.map((result) => result.stdout)).toEqual(['first', 'second', 'third'])
		expect(pty.commands.slice(1)).toEqual(['first', 'second', 'third'])
		await transport.close()
	})

	test('output past the cap fails the session', async () => {
		const { transport } = await openWith(
			{ reply: () => ({ stdout: 'x'.repeat(20_000) }) },
			{ maxOutputBytes: 4096 },
		)
		await expect(transport.run('cat /dev/urandom')).rejects.toThrow(/4096/)
		await expect(transport.run('true')).rejects.toBeInstanceOf(PveShellTransportError)
	})

	test('a closed session refuses to run', async () => {
		const { transport } = await openWith()
		await transport.close()
		await expect(transport.run('true')).rejects.toBeInstanceOf(PveShellTransportError)
	})
})

describe('file transfer', () => {
	let dir: string | undefined
	afterEach(() => {
		if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
		dir = undefined
	})

	test('download checks the size, then decodes base64 into the local file', async () => {
		dir = mkdtempSync(join(tmpdir(), 'pve-agent-shell-'))
		const local = join(dir, 'motd')
		const { pty, transport } = await openWith({
			reply: (command) => {
				if (command.startsWith('stat ')) return { stdout: '5\r\n' }
				if (command.startsWith('base64 ')) {
					return { stdout: `${Buffer.from('hello').toString('base64')}\r\n` }
				}
				return undefined
			},
		})
		await transport.download('/etc/motd', local)
		expect(await Bun.file(local).text()).toBe('hello')
		expect(pty.commands.slice(1)).toEqual(['stat -c %s -- /etc/motd', 'base64 -w 0 -- /etc/motd'])
		await transport.close()
	})

	test('a file over the transfer limit is refused before it is read', async () => {
		const { pty, transport } = await openWith(
			{ reply: () => ({ stdout: '99999999\r\n' }) },
			{ maxTransferBytes: 1024 },
		)
		await expect(transport.download('/big', '/tmp/never-written')).rejects.toThrow(/transfer limit/)
		expect(pty.commands.filter((command) => command.startsWith('base64'))).toEqual([])
		await transport.close()
	})

	test('a size the node did not answer with is a failure', async () => {
		const { transport } = await openWith({
			reply: (command) =>
				command.startsWith('stat ') ? { stdout: 'stat: cannot statx\r\n' } : undefined,
		})
		await expect(transport.download('/etc/motd', '/tmp/never-written')).rejects.toThrow(
			/size of \/etc\/motd/,
		)
		await transport.close()
	})

	test('upload sends the content as base64 chunks and renames it into place', async () => {
		dir = mkdtempSync(join(tmpdir(), 'pve-agent-shell-'))
		const local = join(dir, 'source')
		const content = 'x'.repeat(1500)
		await Bun.write(local, content)
		const { pty, transport } = await openWith({
			reply: (command) =>
				command.startsWith('mktemp ') ? { stdout: '/tmp/pve-agent.AbCdEf\r\n' } : undefined,
		})
		await transport.upload(local, '/etc/motd')
		const commands = pty.commands.slice(1)
		expect(commands[0]).toBe('mktemp /tmp/pve-agent.XXXXXX')
		const appends = commands.filter((command) => command.startsWith('printf %s '))
		expect(appends).toHaveLength(2)
		const encoded = appends
			.map((command) => /printf %s ([A-Za-z0-9+/=]+) >> \/tmp\/pve-agent.AbCdEf/.exec(command)?.[1])
			.join('')
		expect(Buffer.from(encoded, 'base64').toString()).toBe(content)
		expect(commands.at(-2)).toContain(
			'base64 -d /tmp/pve-agent.AbCdEf > "$o"; mv -f -- "$o" /etc/motd',
		)
		expect(commands.at(-1)).toBe('rm -f -- /tmp/pve-agent.AbCdEf')
		await transport.close()
	})
})

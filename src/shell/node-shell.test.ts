import { afterEach, describe, expect, test } from 'bun:test'
import { closeMockClients, mockClient } from '../core/test-support/api-mock.ts'
import { PveShellCommandError, PveShellCredentialError, PveShellPolicyError } from './errors.ts'
import { NodeShell } from './node-shell.ts'
import type { SpawnFn } from './spawn.ts'
import { FakePty, FakeTransport } from './test-support.ts'

afterEach(closeMockClients)

const encoder = new TextEncoder()

function sshAnswering(exitCode: number, stderr = ''): SpawnFn {
	return async () => ({
		exitCode,
		stdout: new Uint8Array(0),
		stderr: encoder.encode(stderr),
		timedOut: false,
	})
}

const sshRefused = sshAnswering(255, 'root@ms01-0160: Permission denied (publickey).')

describe('the policy in front of the transport', () => {
	test('a refused command never reaches the transport', async () => {
		const transport = new FakeTransport()
		const shell = new NodeShell(transport)
		await expect(shell.run('rm -rf /')).rejects.toBeInstanceOf(PveShellPolicyError)
		await expect(shell.output('zpool destroy tank')).rejects.toBeInstanceOf(PveShellPolicyError)
		expect(transport.commands).toEqual([])
	})

	test('input that feeds an interpreter goes through the policy too', async () => {
		const transport = new FakeTransport()
		const shell = new NodeShell(transport)
		for (const command of ['sh', 'bash -s', '/bin/dash', 'xargs rm', 'python3 -', 'perl']) {
			await expect(shell.run(command, { input: 'rm -rf /\n' })).rejects.toBeInstanceOf(
				PveShellPolicyError,
			)
		}
		await expect(
			shell.run('sh', { input: new TextEncoder().encode('echo ok\nreboot\n') }),
		).rejects.toBeInstanceOf(PveShellPolicyError)
		expect(transport.commands).toEqual([])
		await shell.run('sh', { input: 'echo ok\nrm /tmp/x\n' })
		await shell.run('cat > /tmp/notes', { input: 'rm -rf /\n' })
		expect(transport.commands).toEqual(['sh', 'cat > /tmp/notes'])
	})

	test('the policy options are applied', async () => {
		const transport = new FakeTransport()
		const shell = new NodeShell(transport, { allow: ['zpool'], destructive: 'allow' })
		await shell.run('zpool destroy tank')
		await expect(shell.run('zfs list')).rejects.toBeInstanceOf(PveShellPolicyError)
		expect(transport.commands).toEqual(['zpool destroy tank'])
		expect(shell.policy.explain('zfs list').allowed).toBe(false)
	})
})

describe('run and output', () => {
	test('run passes the options through and returns the result', async () => {
		const transport = new FakeTransport({ reply: () => ({ exitCode: 3, stderr: 'no' }) })
		const shell = new NodeShell(transport)
		const result = await shell.run('false', { timeoutMs: 5, input: 'x' })
		expect(result).toMatchObject({ exitCode: 3, stderr: 'no' })
		expect(transport.calls[0]?.options).toEqual({ timeoutMs: 5, input: 'x' })
		expect(shell.node).toBe('test-node')
		expect(shell.kind).toBe('ssh')
	})

	test('output trims stdout and asks the transport to check the exit code', async () => {
		const transport = new FakeTransport({ reply: () => ({ stdout: ' ok \n' }) })
		const shell = new NodeShell(transport)
		expect(await shell.output('zpool list')).toBe('ok')
		expect(transport.calls[0]?.options.check).toBe(true)
	})

	test('output throws what the transport throws for a failed command', async () => {
		const transport = new FakeTransport()
		transport.run = async () => {
			throw new PveShellCommandError({
				node: 'n',
				command: 'c',
				exitCode: 1,
				stdout: '',
				stderr: '',
			})
		}
		await expect(new NodeShell(transport).output('false')).rejects.toBeInstanceOf(
			PveShellCommandError,
		)
	})

	test('upload, download and close go to the transport', async () => {
		const transport = new FakeTransport()
		const shell = new NodeShell(transport)
		await shell.upload('/local', '/remote')
		await shell.download('/remote', '/local')
		await shell.close()
		expect(transport.uploads).toEqual([{ localPath: '/local', remotePath: '/remote' }])
		expect(transport.downloads).toEqual([{ remotePath: '/remote', localPath: '/local' }])
		expect(transport.closes).toBe(1)
	})
})

describe('transport selection', () => {
	test('auto takes ssh when the probe passes, with the node name as the host', async () => {
		const shell = await NodeShell.open({ node: 'ms01-0160', ssh: { spawn: sshAnswering(0) } })
		expect(shell.kind).toBe('ssh')
		expect(shell.node).toBe('ms01-0160')
		expect(shell.transport.description).toBe('ssh root@ms01-0160')
	})

	test('auto falls back to termproxy when the client holds a root@pam ticket', async () => {
		const mock = mockClient()
		mock.reply({ data: { port: 5900, ticket: 'T', user: 'root@pam' } })
		const pty = new FakePty()
		const shell = await NodeShell.open({
			node: 'ms01-0160',
			client: mock.client,
			ssh: { spawn: sshRefused },
			termproxy: { socketFactory: () => pty, connectTimeoutMs: 2000 },
		})
		expect(shell.kind).toBe('termproxy')
		expect((await shell.run('true')).exitCode).toBe(0)
		await shell.close()
		expect(pty.closes).toBe(1)
	})

	test('auto with no client and no key is a credential error naming both fixes', async () => {
		const error = await NodeShell.open({ node: 'ms01-0160', ssh: { spawn: sshRefused } }).then(
			() => undefined,
			(caught: unknown) => caught,
		)
		expect(error).toBeInstanceOf(PveShellCredentialError)
		if (error instanceof PveShellCredentialError) {
			expect(error.node).toBe('ms01-0160')
			expect(error.message).toContain('Permission denied')
			expect(error.message).toContain('root@pam')
		}
	})

	test('auto with a ticket for another user is a credential error and sends no request', async () => {
		const mock = mockClient({ ticket: 'agents@pve' })
		const error = await NodeShell.open({
			node: 'ms01-0160',
			client: mock.client,
			ssh: { spawn: sshRefused },
		}).then(
			() => undefined,
			(caught: unknown) => caught,
		)
		expect(error).toBeInstanceOf(PveShellCredentialError)
		if (error instanceof PveShellCredentialError) expect(error.message).toContain('agents@pve')
		expect(mock.requests).toHaveLength(0)
	})

	test('a forced ssh transport does not fall back', async () => {
		const mock = mockClient()
		await expect(
			NodeShell.open({
				node: 'ms01-0160',
				transport: 'ssh',
				client: mock.client,
				ssh: { spawn: sshRefused },
			}),
		).rejects.toBeInstanceOf(PveShellCredentialError)
		expect(mock.requests).toHaveLength(0)
	})

	test('a forced termproxy transport needs a client and skips the ssh probe', async () => {
		let probed = false
		const spawn: SpawnFn = async (request) => {
			probed = true
			return sshAnswering(0)(request)
		}
		await expect(
			NodeShell.open({ node: 'ms01-0160', transport: 'termproxy', ssh: { spawn } }),
		).rejects.toBeInstanceOf(PveShellCredentialError)
		expect(probed).toBe(false)
	})

	test('ssh settings reach the transport', async () => {
		const shell = await NodeShell.open({
			node: 'ms01-0160',
			ssh: { host: '192.168.80.21', user: 'admin', port: 2222, spawn: sshAnswering(0) },
		})
		expect(shell.transport.description).toBe('ssh admin@192.168.80.21 -p 2222')
	})
})

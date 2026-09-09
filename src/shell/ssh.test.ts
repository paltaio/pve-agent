import { describe, expect, test } from 'bun:test'
import { PveShellCommandError, PveShellTimeoutError, PveShellTransportError } from './errors.ts'
import type { SpawnRequest } from './spawn.ts'
import { probeSsh, SshTransport } from './ssh.ts'
import { fakeSpawn } from './test-support.ts'

const encoder = new TextEncoder()
const decode = (bytes: Uint8Array | undefined): string => new TextDecoder().decode(bytes)

describe('argument vector', () => {
	test('carries batch mode, the host key policy, the connect timeout and the command', () => {
		const transport = new SshTransport({ host: '192.0.2.21', node: 'ms01-0160' })
		expect(transport.node).toBe('ms01-0160')
		expect(transport.description).toBe('ssh root@192.0.2.21')
		expect(transport.argv('zpool status')).toEqual([
			'ssh',
			'-o',
			'BatchMode=yes',
			'-o',
			'StrictHostKeyChecking=accept-new',
			'-o',
			'ConnectTimeout=10',
			'--',
			'root@192.0.2.21',
			'zpool status',
		])
	})

	test('adds the identity file, known hosts, multiplexing, port, user and extra arguments', () => {
		const transport = new SshTransport({
			host: 'node',
			user: 'admin',
			port: 2222,
			identityFile: '/keys/id_ed25519',
			knownHostsFile: '/keys/known_hosts',
			strictHostKeyChecking: 'yes',
			connectTimeoutSeconds: 3,
			controlPath: '/tmp/cm',
			controlPersistSeconds: 30,
			extraArgs: ['-vv'],
			sshBinary: '/opt/ssh',
		})
		expect(transport.argv('true')).toEqual([
			'/opt/ssh',
			'-o',
			'BatchMode=yes',
			'-o',
			'StrictHostKeyChecking=yes',
			'-o',
			'ConnectTimeout=3',
			'-o',
			'UserKnownHostsFile=/keys/known_hosts',
			'-o',
			'IdentitiesOnly=yes',
			'-i',
			'/keys/id_ed25519',
			'-o',
			'ControlMaster=auto',
			'-o',
			'ControlPersist=30',
			'-o',
			'ControlPath=/tmp/cm',
			'-p',
			'2222',
			'-vv',
			'--',
			'admin@node',
			'true',
		])
		expect(transport.description).toBe('ssh admin@node -p 2222')
	})
})

describe('run', () => {
	test('returns the exit code and keeps the streams apart', async () => {
		const transport = new SshTransport({
			host: 'node',
			spawn: fakeSpawn(() => ({
				exitCode: 3,
				stdout: encoder.encode('out'),
				stderr: encoder.encode('err'),
			})),
		})
		const result = await transport.run('false')
		expect(result.exitCode).toBe(3)
		expect(result.stdout).toBe('out')
		expect(result.stderr).toBe('err')
		expect(result.durationMs).toBeGreaterThanOrEqual(0)
	})

	test('check turns a non-zero exit into an error carrying the output', async () => {
		const transport = new SshTransport({
			host: 'node',
			spawn: fakeSpawn(() => ({ exitCode: 2, stderr: encoder.encode('no such pool') })),
		})
		const error = await transport.run('zpool status tank', { check: true }).then(
			() => undefined,
			(caught: unknown) => caught,
		)
		expect(error).toBeInstanceOf(PveShellCommandError)
		if (error instanceof PveShellCommandError) {
			expect(error.exitCode).toBe(2)
			expect(error.stderr).toBe('no such pool')
			expect(error.message).toContain('no such pool')
		}
	})

	test('input reaches the process and the timeout is passed on', async () => {
		const log: SpawnRequest[] = []
		const transport = new SshTransport({ host: 'node', spawn: fakeSpawn(() => ({}), log) })
		await transport.run('cat', { input: 'payload', timeoutMs: 42 })
		expect(decode(log[0]?.input)).toBe('payload')
		expect(log[0]?.timeoutMs).toBe(42)
	})

	test('cwd and env are folded into the command line', async () => {
		const log: SpawnRequest[] = []
		const transport = new SshTransport({ host: 'node', spawn: fakeSpawn(() => ({}), log) })
		await transport.run('pwd', { cwd: '/etc/pve', env: { LC_ALL: 'C' } })
		expect(log[0]?.argv.at(-1)).toBe('cd -- /etc/pve || exit $?; export LC_ALL=C\npwd')
	})

	test("ssh's own failure is a transport error, not a command failure", async () => {
		for (const stderr of [
			'root@node: Permission denied (publickey).',
			'ssh: connect to host node port 22: Connection refused',
			'Host key verification failed.',
		]) {
			const transport = new SshTransport({
				host: 'node',
				spawn: fakeSpawn(() => ({ exitCode: 255, stderr: encoder.encode(stderr) })),
			})
			await expect(transport.run('true')).rejects.toThrow(PveShellTransportError)
		}
	})

	test('a command that exits 255 on its own is not mistaken for an ssh failure', async () => {
		const transport = new SshTransport({
			host: 'node',
			spawn: fakeSpawn(() => ({
				exitCode: 255,
				stderr: encoder.encode('cat: /root/.ssh/id_ed25519: Permission denied\n'),
			})),
		})
		const result = await transport.run('cat /root/.ssh/id_ed25519')
		expect(result.exitCode).toBe(255)
		expect(result.stderr).toContain('Permission denied')
	})

	test('a killed process becomes a timeout error carrying the partial output', async () => {
		const transport = new SshTransport({
			host: 'node',
			spawn: fakeSpawn(() => ({
				exitCode: 137,
				timedOut: true,
				stdout: encoder.encode('partial'),
			})),
		})
		const error = await transport.run('sleep 100', { timeoutMs: 10 }).then(
			() => undefined,
			(caught: unknown) => caught,
		)
		expect(error).toBeInstanceOf(PveShellTimeoutError)
		if (error instanceof PveShellTimeoutError) {
			expect(error.timeoutMs).toBe(10)
			expect(error.partialOutput).toBe('partial')
		}
	})

	test('a binary that cannot start is a transport error', async () => {
		const transport = new SshTransport({
			host: 'node',
			spawn: () => Promise.reject(new Error('ENOENT')),
		})
		await expect(transport.run('true')).rejects.toThrow(PveShellTransportError)
	})
})

describe('scp', () => {
	test('upload runs scp with the port in scp spelling and the operands after --', async () => {
		const log: SpawnRequest[] = []
		const transport = new SshTransport({
			host: 'node',
			port: 2222,
			spawn: fakeSpawn(() => ({}), log),
		})
		await transport.upload('/local/file', '/remote/file')
		const argv = log[0]?.argv ?? []
		expect(argv[0]).toBe('scp')
		expect(argv[1]).toBe('-q')
		expect(argv).toContain('-P')
		expect(argv).not.toContain('-p')
		expect(argv.slice(argv.indexOf('--') + 1)).toEqual(['/local/file', 'root@node:/remote/file'])
	})

	test('download puts a local path that looks like an option after -- as well', async () => {
		const log: SpawnRequest[] = []
		const transport = new SshTransport({ host: 'node', spawn: fakeSpawn(() => ({}), log) })
		await transport.download('/etc/hosts', '-oProxyCommand=touch /tmp/pwned')
		const argv = log[0]?.argv ?? []
		expect(argv.slice(argv.indexOf('--') + 1)).toEqual([
			'root@node:/etc/hosts',
			'-oProxyCommand=touch /tmp/pwned',
		])
	})

	test('sftp mode adds -s before the operands', async () => {
		const log: SpawnRequest[] = []
		const transport = new SshTransport({
			host: 'node',
			sftp: true,
			spawn: fakeSpawn(() => ({}), log),
		})
		await transport.upload('/local/file', '/remote/$(id)')
		const argv = log[0]?.argv ?? []
		expect(argv.indexOf('-s')).toBeGreaterThan(0)
		expect(argv.indexOf('-s')).toBeLessThan(argv.indexOf('--'))
		expect(argv.slice(argv.indexOf('--') + 1)).toEqual(['/local/file', 'root@node:/remote/$(id)'])
	})

	test('a failed copy is a transport error with scp output', async () => {
		const transport = new SshTransport({
			host: 'node',
			spawn: fakeSpawn(() => ({
				exitCode: 1,
				stderr: encoder.encode('scp: /remote: No such file'),
			})),
		})
		await expect(transport.download('/remote', '/local')).rejects.toThrow(/No such file/)
	})
})

describe('close', () => {
	test('sends nothing without multiplexing', async () => {
		const log: SpawnRequest[] = []
		await new SshTransport({ host: 'node', spawn: fakeSpawn(() => ({}), log) }).close()
		expect(log).toHaveLength(0)
	})

	test('asks the control master to exit', async () => {
		const log: SpawnRequest[] = []
		const transport = new SshTransport({
			host: 'node',
			controlPath: '/tmp/cm',
			spawn: fakeSpawn(() => ({}), log),
		})
		await transport.close()
		expect(log[0]?.argv?.slice(-4)).toEqual(['-O', 'exit', '--', 'root@node'])
	})
})

describe('probeSsh', () => {
	test('reports success when the probe command runs', async () => {
		expect(await probeSsh({ host: 'node', spawn: fakeSpawn(() => ({})) })).toEqual({
			ok: true,
			detail: '',
		})
	})

	test('reports the reason when ssh refuses', async () => {
		const probe = await probeSsh({
			host: 'node',
			spawn: fakeSpawn(() => ({
				exitCode: 255,
				stderr: encoder.encode('root@node: Permission denied (publickey).'),
			})),
		})
		expect(probe.ok).toBe(false)
		expect(probe.detail).toContain('Permission denied')
	})
})

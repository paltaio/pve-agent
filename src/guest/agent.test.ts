import { afterEach, describe, expect, test } from 'bun:test'
import { GuestCommandError, PveTimeoutError } from '../core/errors.ts'
import {
	closeMockClients,
	formFields,
	formObject,
	mockClient,
} from '../core/test-support/api-mock.ts'
import { QemuAgent } from './agent.ts'

afterEach(closeMockClients)

const ref = { node: 'ms01-0160', vmid: 9000 }
const base = '/nodes/ms01-0160/qemu/9000/agent'

describe('exec', () => {
	test('sends the command as a repeated key and polls until the process exits', async () => {
		const mock = mockClient()
		mock.reply({ data: { pid: 4242 } })
		mock.reply({ data: { exited: 0 } })
		mock.reply({ data: { exited: 1, exitcode: 0, 'out-data': 'ok\n', 'out-truncated': 0 } })
		const agent = new QemuAgent(mock.client, ref)

		const result = await agent.exec(['sh', '-c', 'echo ok'], { initialDelayMs: 1 })

		const [start, poll] = mock.calls()
		expect(start?.path).toBe(`${base}/exec`)
		expect(formFields(start ?? mock.last()).getAll('command')).toEqual(['sh', '-c', 'echo ok'])
		expect(poll?.path).toBe(`${base}/exec-status?pid=4242`)
		expect(result).toMatchObject({
			pid: 4242,
			exited: true,
			exitCode: 0,
			stdout: 'ok\n',
			timedOut: false,
		})
	})

	test('passes stdin as input-data', async () => {
		const mock = mockClient()
		mock.reply({ data: { pid: 1 } })
		mock.reply({ data: { exited: 1, exitcode: 0 } })
		await new QemuAgent(mock.client, ref).exec(['cat'], { inputData: 'hi' })
		expect(formObject(mock.calls()[0] ?? mock.last())).toEqual({
			command: 'cat',
			'input-data': 'hi',
		})
	})

	test('reports timedOut when the poll deadline passes', async () => {
		const mock = mockClient()
		mock.reply({ data: { pid: 7 } })
		mock.reply({ data: { exited: 0 } })
		const result = await new QemuAgent(mock.client, ref).exec(['sleep', '60'], { timeoutMs: 0 })
		expect(result.exited).toBe(false)
		expect(result.timedOut).toBe(true)
		expect(result.pid).toBe(7)
	})

	test('repairs the byte encoding PVE puts on agent output', async () => {
		const mock = mockClient()
		mock.reply({ data: { pid: 1 } })
		// The UTF-8 bytes C3 B1 of a single character arrive as two code points.
		mock.reply({ data: { exited: 1, exitcode: 0, 'out-data': '\u00c3\u00b1\n' } })
		const result = await new QemuAgent(mock.client, ref).exec(['printf', 'x'])
		expect(result.stdout).toBe('\u00f1\n')
	})
})

describe('output', () => {
	test('returns stdout without trailing whitespace', async () => {
		const mock = mockClient()
		mock.reply({ data: { pid: 1 } })
		mock.reply({ data: { exited: 1, exitcode: 0, 'out-data': 'Linux host\n' } })
		expect(await new QemuAgent(mock.client, ref).output(['uname', '-a'])).toBe('Linux host')
	})

	test('throws GuestCommandError with the exit code and stderr on failure', async () => {
		const mock = mockClient()
		mock.reply({ data: { pid: 1 } })
		mock.reply({ data: { exited: 1, exitcode: 3, 'err-data': 'nope\n' } })
		const call = new QemuAgent(mock.client, ref).output(['sh', '-c', 'exit 3'])
		await expect(call).rejects.toBeInstanceOf(GuestCommandError)
		await expect(call).rejects.toMatchObject({ exitCode: 3, stderr: 'nope\n', vmid: 9000 })
	})

	test('folds a signal death into the exit code', async () => {
		const mock = mockClient()
		mock.reply({ data: { pid: 1 } })
		mock.reply({ data: { exited: 1, signal: 9 } })
		await expect(new QemuAgent(mock.client, ref).output(['sleep', '9'])).rejects.toMatchObject({
			exitCode: 137,
		})
	})

	test('throws PveTimeoutError while the process is still running', async () => {
		const mock = mockClient()
		mock.reply({ data: { pid: 5 } })
		mock.reply({ data: { exited: 0 } })
		const call = new QemuAgent(mock.client, ref).output(['sleep', '60'], { timeoutMs: 0 })
		await expect(call).rejects.toBeInstanceOf(PveTimeoutError)
		await expect(call).rejects.toThrow(/pid 5/)
	})
})

describe('simple commands', () => {
	test('unwraps the result envelope the agent endpoints use', async () => {
		const mock = mockClient()
		const agent = new QemuAgent(mock.client, ref)

		mock.reply({ data: { result: { 'pretty-name': 'Debian GNU/Linux 13', name: 'Debian' } } })
		expect((await agent.osInfo()).name).toBe('Debian')
		expect([mock.last().method, mock.last().path]).toEqual(['GET', `${base}/get-osinfo`])

		mock.reply({ data: { result: { 'host-name': 'demo' } } })
		expect(await agent.hostName()).toBe('demo')

		mock.reply({ data: { result: [{ name: 'eth0', 'ip-addresses': [] }] } })
		expect((await agent.networkInterfaces())[0]?.name).toBe('eth0')
		expect(mock.last().path).toBe(`${base}/network-get-interfaces`)

		mock.reply({ data: { result: 'thawed' } })
		expect(await agent.fsfreezeStatus()).toBe('thawed')
		expect([mock.last().method, mock.last().path]).toEqual(['POST', `${base}/fsfreeze-status`])

		mock.reply({ data: { result: 2 } })
		expect(await agent.fsfreezeFreeze()).toBe(2)
		mock.reply({ data: { result: 2 } })
		expect(await agent.fsfreezeThaw()).toBe(2)

		await agent.ping()
		expect([mock.last().method, mock.last().path]).toEqual(['POST', `${base}/ping`])

		mock.reply({ data: { result: null } })
		await agent.suspendRam()
		expect(mock.last().path).toBe(`${base}/suspend-ram`)

		mock.reply({ data: { result: { hello: 1 } } })
		expect(await agent.run<{ hello: number }>('info')).toEqual({ hello: 1 })
		expect(formObject(mock.last())).toEqual({ command: 'info' })
	})

	test('setUserPassword posts the account and the flag', async () => {
		const mock = mockClient()
		await new QemuAgent(mock.client, ref).setUserPassword({
			username: 'root',
			password: 'pw',
			crypted: false,
		})
		expect(mock.last().path).toBe(`${base}/set-user-password`)
		expect(formObject(mock.last())).toEqual({ username: 'root', password: 'pw', crypted: '0' })
	})
})

describe('files', () => {
	test('fileRead decodes the content and reads the flags', async () => {
		const mock = mockClient()
		mock.reply({ data: { content: 'hello\n', truncated: 0, 'bytes-read': 6 } })
		const file = await new QemuAgent(mock.client, ref).fileRead('/etc/hostname', { count: 64 })
		expect(file).toEqual({ content: 'hello\n', truncated: false, bytesRead: 6 })
		expect(mock.last().path).toBe(`${base}/file-read?count=64&file=%2Fetc%2Fhostname`)
	})

	test('fileWrite sends base64 built here and turns the node encoding off', async () => {
		const mock = mockClient()
		const agent = new QemuAgent(mock.client, ref)
		await agent.fileWrite('/tmp/x', 'hi \u00f1\n')
		expect(mock.last().path).toBe(`${base}/file-write`)
		expect(formObject(mock.last())).toEqual({
			file: '/tmp/x',
			content: Buffer.from('hi \u00f1\n', 'utf8').toString('base64'),
			encode: '0',
		})

		await agent.fileWrite('/tmp/y', new Uint8Array([0, 255]))
		expect(formObject(mock.last())['content']).toBe('AP8=')
	})
})

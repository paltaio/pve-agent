import { afterEach, describe, expect, test } from 'bun:test'
import {
	GuestCommandError,
	GuestOutputTruncatedError,
	PveApiError,
	PveConfigError,
	PveError,
	PveTimeoutError,
} from '../core/errors.ts'
import { closeMockClients, formFields, mockClient } from '../core/test-support/api-mock.ts'
import { QemuAgent } from '../guest/agent.ts'
import { LxcApi } from '../guest/lxc.ts'
import { QemuApi } from '../guest/qemu.ts'
import { PveShellTimeoutError } from '../shell/errors.ts'
import { NodeShell } from '../shell/node-shell.ts'
import { FakeTransport } from '../shell/test-support.ts'
import type { ShellTransport } from '../shell/types.ts'
import { DarwinGuest } from './darwin.ts'
import { pctExecutor, qemuAgentExecutor } from './executor.ts'
import {
	detectGuestOs,
	guestOsFromOsInfo,
	guestOsFromOstype,
	openGuestOs,
	waitForAgent,
} from './guest-os.ts'
import { LinuxGuest } from './linux.ts'
import { POSIX_WRITE_CHUNK_BYTES } from './posix.ts'
import type { GuestExecutor, GuestRunResult } from './types.ts'
import { psEncode, WINDOWS_WRITE_CHUNK_BYTES, WindowsGuest } from './windows.ts'

afterEach(closeMockClients)

const VMID = 9060

function fakeExecutor(reply: (argv: readonly string[]) => Partial<GuestRunResult> = () => ({})): {
	executor: GuestExecutor
	calls: (readonly string[])[]
} {
	const calls: (readonly string[])[] = []
	const executor: GuestExecutor = {
		vmid: VMID,
		async exec(argv) {
			calls.push(argv)
			const answer = reply(argv)
			return {
				exitCode: answer.exitCode ?? 0,
				stdout: answer.stdout ?? '',
				stderr: answer.stderr ?? '',
				timedOut: answer.timedOut ?? false,
				truncated: answer.truncated ?? false,
			}
		},
	}
	return { executor, calls }
}

/** The script behind the last `-EncodedCommand` argument of a call. */
function encodedScript(argv: readonly string[] | undefined): string {
	const encoded = argv?.[argv.length - 1] ?? ''
	return Buffer.from(encoded, 'base64').toString('utf16le')
}

function agentOn(mock: ReturnType<typeof mockClient>): QemuAgent {
	return new QemuAgent(mock.client, { node: 'ms02-0078', vmid: VMID })
}

describe('qemuAgentExecutor', () => {
	test('reports the exit code, or 128 plus the signal for a killed process', async () => {
		const mock = mockClient()
		mock.reply({ data: { pid: 1 } })
		mock.reply({ data: { exited: 1, exitcode: 3, 'out-data': 'out', 'err-data': 'err' } })
		mock.reply({ data: { pid: 2 } })
		mock.reply({ data: { exited: 1, signal: 9 } })
		const executor = qemuAgentExecutor(agentOn(mock))

		expect(await executor.exec(['false'])).toEqual({
			exitCode: 3,
			stdout: 'out',
			stderr: 'err',
			timedOut: false,
			truncated: false,
		})
		expect((await executor.exec(['sleep'])).exitCode).toBe(137)
	})

	test('a truncated stream is reported on the result', async () => {
		const mock = mockClient()
		mock.reply({ data: { pid: 1 } })
		mock.reply({ data: { exited: 1, exitcode: 0, 'out-data': 'x', 'out-truncated': 1 } })
		expect((await qemuAgentExecutor(agentOn(mock)).exec(['cat'])).truncated).toBe(true)
	})

	test('a command still running at the deadline comes back as timed out', async () => {
		const mock = mockClient()
		mock.reply({ data: { pid: 1 } })
		mock.reply({ data: { exited: 0 } })
		const result = await qemuAgentExecutor(agentOn(mock)).exec(['sleep', '60'], { timeoutMs: 0 })
		expect(result.timedOut).toBe(true)
		expect(result.exitCode).toBe(-1)
	})

	test('passes stdin through as input-data', async () => {
		const mock = mockClient()
		mock.reply({ data: { pid: 1 } })
		mock.reply({ data: { exited: 1, exitcode: 0 } })
		await qemuAgentExecutor(agentOn(mock)).exec(['cat'], { input: 'hi' })
		expect(formFields(mock.calls()[0] ?? mock.last()).get('input-data')).toBe('hi')
	})
})

describe('pctExecutor', () => {
	test('runs the program through pct exec and hands back the exit code', async () => {
		const transport = new FakeTransport({
			node: 'ms02-0078',
			reply: () => ({ exitCode: 3, stdout: 'out' }),
		})
		const result = await pctExecutor(new NodeShell(transport), VMID).exec(['/bin/echo', 'a b'])
		expect(transport.commands[0]).toBe("pct exec 9060 -- /bin/echo 'a b'")
		expect(result).toEqual({
			exitCode: 3,
			stdout: 'out',
			stderr: '',
			timedOut: false,
			truncated: false,
		})
	})

	test('a shell timeout comes back as a timed out result', async () => {
		const transport: ShellTransport = {
			kind: 'ssh',
			node: 'ms02-0078',
			description: 'fake',
			async run(command, options) {
				throw new PveShellTimeoutError({
					node: 'ms02-0078',
					command,
					timeoutMs: options?.timeoutMs ?? 0,
					partialOutput: 'partial',
				})
			},
			async upload() {},
			async download() {},
			async close() {},
		}
		const result = await pctExecutor(new NodeShell(transport), VMID).exec(['sleep', '60'], {
			timeoutMs: 10,
		})
		expect(result).toEqual({
			exitCode: -1,
			stdout: 'partial',
			stderr: '',
			timedOut: true,
			truncated: false,
		})
	})
})

describe('LinuxGuest', () => {
	test('a command line and a script both go through /bin/sh -c', async () => {
		const { executor, calls } = fakeExecutor()
		const guest = new LinuxGuest(executor)
		await guest.run('id -u')
		await guest.sh('for i in 1 2; do\n  echo $i\ndone')
		expect(calls[0]).toEqual(['/bin/sh', '-c', 'id -u'])
		expect(calls[1]).toEqual(['/bin/sh', '-c', 'for i in 1 2; do\n  echo $i\ndone'])
	})

	test('output trims trailing whitespace and keeps the rest', async () => {
		const { executor } = fakeExecutor(() => ({ stdout: '  1000\n' }))
		expect(await new LinuxGuest(executor).output('id -u')).toBe('  1000')
	})

	test('a failed command names the guest and carries the output', async () => {
		const { executor } = fakeExecutor(() => ({ exitCode: 1, stderr: 'no such file' }))
		const error = await new LinuxGuest(executor)
			.readFile('/nope')
			.catch((caught: unknown) => caught)
		expect(error).toBeInstanceOf(GuestCommandError)
		// Callers branch on PveError and its kind, so a guest failure has to be one.
		expect(error).toBeInstanceOf(PveError)
		if (!(error instanceof GuestCommandError)) throw new Error('expected GuestCommandError')
		expect(error.kind).toBe('guest-command')
		expect(error.vmid).toBe(VMID)
		expect(error.message).toContain('guest 9060')
		expect(error.message).toContain('no such file')
	})

	test('output on a command that outlives the wait throws a timeout', async () => {
		const { executor } = fakeExecutor(() => ({ exitCode: -1, timedOut: true }))
		await expect(new LinuxGuest(executor).output('sleep 60')).rejects.toBeInstanceOf(
			PveTimeoutError,
		)
	})

	test('a file write goes over as base64 and is decoded in the guest', async () => {
		const { executor, calls } = fakeExecutor()
		await new LinuxGuest(executor).writeFile('/etc/motd', 'hi there\n', { mode: '0644' })
		const line = calls[0]?.[2] ?? ''
		expect(line).toContain(`printf %s ${Buffer.from('hi there\n').toString('base64')}`)
		expect(line).toContain('base64 -d | tee /etc/motd > /dev/null')
		expect(calls[1]?.[2]).toBe('chmod 0644 /etc/motd')
	})

	test('a sudo write goes through sudo -n for tee and chmod', async () => {
		const { executor, calls } = fakeExecutor()
		await new LinuxGuest(executor).writeFile("/etc/it's.conf", new Uint8Array([0, 255]), {
			sudo: true,
			mode: '0600',
		})
		expect(calls[0]?.[2]).toContain("| sudo -n tee '/etc/it'\\''s.conf' > /dev/null")
		expect(calls[1]?.[2]).toBe("sudo -n chmod 0600 '/etc/it'\\''s.conf'")
	})

	test('a file the agent cut short is an error, not a shorter file', async () => {
		const { executor } = fakeExecutor(() => ({ stdout: 'aGVsbG8=', truncated: true }))
		const error = await new LinuxGuest(executor).readFile('/big').catch((caught: unknown) => caught)
		expect(error).toBeInstanceOf(GuestOutputTruncatedError)
		if (error instanceof GuestOutputTruncatedError) {
			expect(error.vmid).toBe(VMID)
			expect(error.message).toContain('read /big')
		}
	})

	test('a write larger than one argument carries goes over in chunks that append', async () => {
		const { executor, calls } = fakeExecutor()
		const content = Buffer.alloc(POSIX_WRITE_CHUNK_BYTES * 2 + 1, 7)
		await new LinuxGuest(executor).writeFile('/tmp/big', content, { sudo: true })
		expect(calls).toHaveLength(3)
		const lines = calls.map((argv) => argv[2] ?? '')
		expect(lines[0]).toContain(
			`printf %s ${content.subarray(0, POSIX_WRITE_CHUNK_BYTES).toString('base64')} |`,
		)
		expect(lines[0]).toEndWith('| sudo -n tee /tmp/big > /dev/null')
		expect(lines[1]).toEndWith('| sudo -n tee -a /tmp/big > /dev/null')
		expect(lines[2]).toContain(`printf %s ${Buffer.from([7]).toString('base64')} |`)
		expect(lines[2]).toEndWith('| sudo -n tee -a /tmp/big > /dev/null')
		for (const line of lines) expect(line.length).toBeLessThan(128 * 1024)
	})

	test('an empty write still creates the file with one command', async () => {
		const { executor, calls } = fakeExecutor()
		await new LinuxGuest(executor).writeFile('/tmp/empty', '')
		expect(calls).toHaveLength(1)
		expect(calls[0]?.[2]).toContain("printf %s '' |")
	})

	test('a file read decodes what the guest printed', async () => {
		const { executor, calls } = fakeExecutor(() => ({
			stdout: `${Buffer.from('body \u00f1').toString('base64')}\n`,
		}))
		expect(await new LinuxGuest(executor).readFile('/etc/host name')).toBe('body \u00f1')
		expect(calls[0]?.[2]).toBe("base64 < '/etc/host name'")
	})

	test('exists follows the exit code of test -e', async () => {
		const { executor, calls } = fakeExecutor((argv) => ({
			exitCode: argv[2]?.includes('/nope') ? 1 : 0,
		}))
		const guest = new LinuxGuest(executor)
		expect(await guest.exists('/etc/hostname')).toBe(true)
		expect(await guest.exists('/nope')).toBe(false)
		expect(calls[0]?.[2]).toBe('test -e /etc/hostname')
	})

	test('delete removes one file and fails when it is missing', async () => {
		const { executor, calls } = fakeExecutor((argv) =>
			argv[2]?.includes('/nope') ? { exitCode: 1, stderr: 'No such file' } : {},
		)
		const guest = new LinuxGuest(executor)
		await guest.delete('/tmp/a b')
		expect(calls[0]?.[2]).toBe("rm -- '/tmp/a b'")
		await expect(guest.delete('/nope')).rejects.toBeInstanceOf(GuestCommandError)
	})

	test('osInfo carries the kernel, the machine and os-release with quotes removed', async () => {
		const { executor } = fakeExecutor(() => ({
			stdout:
				'6.12.0\nx86_64\nNAME="Alpine Linux"\nID=alpine\nVERSION_ID=3.24.0\nPRETTY_NAME="Alpine Linux v3.24"\nHOME_URL="https://alpinelinux.org/"\n',
		}))
		const info = await new LinuxGuest(executor).osInfo()
		expect(info.os).toBe('linux')
		expect(info.id).toBe('alpine')
		expect(info.name).toBe('Alpine Linux')
		expect(info.version).toBe('3.24.0')
		expect(info.prettyName).toBe('Alpine Linux v3.24')
		expect(info.kernel).toBe('6.12.0')
		expect(info.arch).toBe('x86_64')
		expect(info.raw['HOME_URL']).toBe('https://alpinelinux.org/')
	})

	test('systemctl quotes each argument', async () => {
		const { executor, calls } = fakeExecutor()
		await new LinuxGuest(executor).systemctl(['restart', 'my app.service'])
		expect(calls[0]?.[2]).toBe("systemctl restart 'my app.service'")
	})
})

describe('DarwinGuest', () => {
	test('uses the macOS spelling of the base64 decode flag', async () => {
		const { executor, calls } = fakeExecutor()
		await new DarwinGuest(executor).writeFile('/tmp/x', 'body')
		expect(calls[0]?.[0]).toBe('/bin/sh')
		expect(calls[0]?.[2]).toContain('| base64 -D | tee /tmp/x')
	})

	test('osInfo reads sw_vers', async () => {
		const { executor } = fakeExecutor(() => ({
			stdout:
				'24.3.0\narm64\nProductName:\t\tmacOS\nProductVersion:\t\t15.3.1\nBuildVersion:\t\t24D70\n',
		}))
		const info = await new DarwinGuest(executor).osInfo()
		expect(info.os).toBe('darwin')
		expect(info.id).toBe('macos')
		expect(info.version).toBe('15.3.1')
		expect(info.prettyName).toBe('macOS 15.3.1')
		expect(info.arch).toBe('arm64')
		expect(info.raw['BuildVersion']).toBe('24D70')
	})

	test('osascript is called with the script as one argument', async () => {
		const { executor, calls } = fakeExecutor()
		await new DarwinGuest(executor).osascript('display dialog "hi"')
		expect(calls[0]).toEqual(['/usr/bin/osascript', '-e', 'display dialog "hi"'])
	})
})

describe('WindowsGuest', () => {
	test('a command line goes through cmd /c untouched', async () => {
		const { executor, calls } = fakeExecutor()
		await new WindowsGuest(executor).run('echo %USERNAME%')
		expect(calls[0]).toEqual(['C:\\Windows\\System32\\cmd.exe', '/c', 'echo %USERNAME%'])
	})

	test('a script goes over as an encoded command with quotes and newlines intact', async () => {
		const { executor, calls } = fakeExecutor()
		const script = "Write-Output 'it''s fine'\n(Get-CimInstance Win32_OperatingSystem).Caption"
		await new WindowsGuest(executor).sh(script)
		expect(calls[0]?.slice(0, 6)).toEqual([
			'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
			'-NoProfile',
			'-NonInteractive',
			'-ExecutionPolicy',
			'Bypass',
			'-EncodedCommand',
		])
		expect(calls[0]?.[6]).toBe(psEncode(script))
		expect(encodedScript(calls[0])).toBe(script)
	})

	test('a written file is decoded from base64 inside the guest as raw bytes', async () => {
		const { executor, calls } = fakeExecutor()
		await new WindowsGuest(executor).writeFile("C:\\temp\\o'brien.txt", 'say "hi" \u00e9')
		const script = encodedScript(calls[0])
		expect(script).toStartWith("$ErrorActionPreference = 'Stop'; ")
		expect(script).toContain("[IO.File]::WriteAllBytes('C:\\temp\\o''brien.txt', ")
		expect(script).toContain(
			`FromBase64String('${Buffer.from('say "hi" \u00e9').toString('base64')}')`,
		)
	})

	test('a large write is split so each encoded command line stays under the Windows limit', async () => {
		const { executor, calls } = fakeExecutor()
		const content = Buffer.alloc(WINDOWS_WRITE_CHUNK_BYTES + 1, 9)
		await new WindowsGuest(executor).writeFile('C:\\temp\\big.bin', content)
		expect(calls).toHaveLength(2)
		const first = encodedScript(calls[0])
		const second = encodedScript(calls[1])
		expect(first).toContain("[IO.File]::WriteAllBytes('C:\\temp\\big.bin', ")
		expect(first).toContain(content.subarray(0, WINDOWS_WRITE_CHUNK_BYTES).toString('base64'))
		expect(second).toContain("[IO.File]::Open('C:\\temp\\big.bin', [IO.FileMode]::Append)")
		expect(second).toContain(`FromBase64String('${Buffer.from([9]).toString('base64')}')`)
		for (const argv of calls) expect(argv.join(' ').length).toBeLessThan(32767)
	})

	test('a read the agent cut short is an error', async () => {
		const { executor } = fakeExecutor(() => ({ stdout: 'aGVsbG8=', truncated: true }))
		await expect(new WindowsGuest(executor).readFile('C:\\big')).rejects.toBeInstanceOf(
			GuestOutputTruncatedError,
		)
	})

	test('a read file is decoded and loses its byte order mark', async () => {
		const { executor, calls } = fakeExecutor(() => ({
			stdout: `${Buffer.from('\ufeffhello', 'utf8').toString('base64')}\r\n`,
		}))
		expect(await new WindowsGuest(executor).readFile('C:\\temp\\a.txt')).toBe('hello')
		expect(encodedScript(calls[0])).toContain("[IO.File]::ReadAllBytes('C:\\temp\\a.txt')")
	})

	test('exists follows the exit code of Test-Path', async () => {
		const { executor, calls } = fakeExecutor((argv) => ({
			exitCode: encodedScript(argv).includes('nope') ? 1 : 0,
		}))
		const guest = new WindowsGuest(executor)
		expect(await guest.exists('C:\\Windows')).toBe(true)
		expect(await guest.exists('C:\\nope')).toBe(false)
		expect(encodedScript(calls[0])).toContain("Test-Path -LiteralPath 'C:\\Windows'")
	})

	test('a failed command throws with the output', async () => {
		const { executor } = fakeExecutor(() => ({ exitCode: 1, stderr: 'not recognized' }))
		const error = await new WindowsGuest(executor).output('nope').catch((caught: unknown) => caught)
		expect(error).toBeInstanceOf(GuestCommandError)
		if (!(error instanceof GuestCommandError)) throw new Error('expected GuestCommandError')
		expect(error.exitCode).toBe(1)
		expect(error.stderr).toBe('not recognized')
	})

	test('osInfo reads what Win32_OperatingSystem answered', async () => {
		const { executor } = fakeExecutor(() => ({
			stdout:
				'{"Caption":"Microsoft Windows 10 Pro ","Version":"10.0.19045","BuildNumber":"19045","Architecture":"AMD64"}\r\n',
		}))
		const info = await new WindowsGuest(executor).osInfo()
		expect(info.os).toBe('windows')
		expect(info.name).toBe('Microsoft Windows 10 Pro')
		expect(info.kernel).toBe('10.0.19045')
		expect(info.arch).toBe('AMD64')
		expect(info.raw['BuildNumber']).toBe('19045')
	})

	test('hostname comes from the environment', async () => {
		const { executor } = fakeExecutor(() => ({ stdout: 'WIN10-TARGET-2\r\n' }))
		expect(await new WindowsGuest(executor).hostname()).toBe('WIN10-TARGET-2')
	})
})

describe('guestOsFromOstype', () => {
	test('maps the QEMU ostype families', () => {
		expect(guestOsFromOstype('l26')).toBe('linux')
		expect(guestOsFromOstype('l24')).toBe('linux')
		expect(guestOsFromOstype('win11')).toBe('windows')
		expect(guestOsFromOstype('w2k8')).toBe('windows')
		expect(guestOsFromOstype('wxp')).toBe('windows')
		expect(guestOsFromOstype('other')).toBeUndefined()
		expect(guestOsFromOstype('solaris')).toBeUndefined()
		expect(guestOsFromOstype(undefined)).toBeUndefined()
	})
})

describe('guestOsFromOsInfo', () => {
	test('reads the agent report', () => {
		expect(guestOsFromOsInfo({ id: 'mswindows', name: 'Microsoft Windows' })).toBe('windows')
		expect(guestOsFromOsInfo({ id: 'darwin' })).toBe('darwin')
		expect(guestOsFromOsInfo({ id: 'debian', name: 'Debian GNU/Linux' })).toBe('linux')
		expect(guestOsFromOsInfo({})).toBeUndefined()
	})
})

describe('openGuestOs', () => {
	function vmOn(mock: ReturnType<typeof mockClient>): QemuApi {
		return new QemuApi(mock.client, 'ms02-0078', VMID)
	}

	test('a Linux ostype picks the Linux helper without asking the guest', async () => {
		const mock = mockClient()
		mock.reply({ data: { ostype: 'l26' } })
		const guest = await openGuestOs(vmOn(mock))
		expect(guest).toBeInstanceOf(LinuxGuest)
		expect(guest.vmid).toBe(VMID)
		expect(mock.calls().map((call) => call.path)).toEqual([`/nodes/ms02-0078/qemu/${VMID}/config`])
	})

	test('a Windows ostype picks the Windows helper', async () => {
		const mock = mockClient()
		mock.reply({ data: { ostype: 'win10' } })
		expect(await openGuestOs(vmOn(mock))).toBeInstanceOf(WindowsGuest)
	})

	test('other with an Apple SMC device is macOS', async () => {
		const mock = mockClient()
		mock.reply({
			data: { ostype: 'other', args: '-device isa-applesmc,osk="secret" -smbios type=2' },
		})
		expect(await openGuestOs(vmOn(mock))).toBeInstanceOf(DarwinGuest)
		expect(mock.calls()).toHaveLength(1)
	})

	test('other without a hint asks the agent', async () => {
		const mock = mockClient()
		mock.reply({ data: { ostype: 'other' } })
		mock.reply({ data: { result: { id: 'mswindows', name: 'Microsoft Windows' } } })
		expect(await openGuestOs(vmOn(mock))).toBeInstanceOf(WindowsGuest)
		expect(mock.calls()[1]?.path).toBe(`/nodes/ms02-0078/qemu/${VMID}/agent/get-osinfo`)
	})

	test('detect skips the config and os skips everything', async () => {
		const detected = mockClient()
		detected.reply({ data: { result: { id: 'debian' } } })
		expect(await openGuestOs(vmOn(detected), { detect: true })).toBeInstanceOf(LinuxGuest)
		expect(detected.calls().map((call) => call.path)).toEqual([
			`/nodes/ms02-0078/qemu/${VMID}/agent/get-osinfo`,
		])

		const explicit = mockClient()
		expect(await openGuestOs(vmOn(explicit), { os: 'darwin' })).toBeInstanceOf(DarwinGuest)
		expect(explicit.calls()).toHaveLength(0)
	})

	test('a container runs through pct exec on the shell given', async () => {
		const mock = mockClient()
		const transport = new FakeTransport({ node: 'ms02-0078', reply: () => ({ stdout: '0\n' }) })
		const ct = new LxcApi(mock.client, 'ms02-0078', 110)
		const guest = await openGuestOs(ct, { shell: new NodeShell(transport) })
		expect(guest).toBeInstanceOf(LinuxGuest)
		expect(await guest.output('id -u')).toBe('0')
		expect(transport.commands[0]).toBe("pct exec 110 -- /bin/sh -c 'id -u'")
		expect(mock.calls()).toHaveLength(0)
	})

	test('a container refuses a shell on another node', async () => {
		const mock = mockClient()
		const ct = new LxcApi(mock.client, 'ms02-0078', 110)
		const shell = new NodeShell(new FakeTransport({ node: 'ms01-0160' }))
		await expect(openGuestOs(ct, { shell })).rejects.toBeInstanceOf(PveConfigError)
	})
})

describe('detectGuestOs', () => {
	function execReplies(mock: ReturnType<typeof mockClient>, stdout: string, exitcode = 0): void {
		mock.reply({ data: { pid: 1 } })
		mock.reply({ data: { exited: 1, exitcode, 'out-data': stdout } })
	}

	test('falls back to uname when get-osinfo is unsupported', async () => {
		const mock = mockClient()
		mock.reply({ status: 500, body: '{"data":null,"message":"unsupported command"}' })
		execReplies(mock, 'Darwin\n')
		expect(await detectGuestOs(agentOn(mock))).toBe('darwin')
		expect(formFields(mock.calls()[1] ?? mock.last()).getAll('command')).toEqual([
			'/bin/sh',
			'-c',
			'uname -s',
		])
	})

	test('falls back to cmd for a Windows guest that answers neither', async () => {
		const mock = mockClient()
		mock.reply({ data: { result: {} } })
		mock.reply({ status: 500, body: '{"data":null,"message":"Failed to execute child process"}' })
		execReplies(mock, 'Microsoft Windows [Version 10.0.19045.1]\r\n')
		expect(await detectGuestOs(agentOn(mock))).toBe('windows')
	})

	test('says so when the guest answers every probe with nothing known', async () => {
		const mock = mockClient()
		mock.reply({ data: { result: {} } })
		execReplies(mock, 'SunOS\n')
		execReplies(mock, '', 1)
		await expect(detectGuestOs(agentOn(mock))).rejects.toThrow(/could not be identified/)
	})

	// A stopped agent, a missing privilege and a dead node all reach here as a
	// rejection, and none of them is the guest failing to answer. The original
	// error comes back untouched, so its class still says which one it was.
	test('rethrows the failure that stopped the probes', async () => {
		const mock = mockClient()
		for (let n = 0; n < 3; n++) {
			mock.reply({ status: 500, body: '{"data":null,"message":"QEMU guest agent is not running"}' })
		}
		const error = await detectGuestOs(agentOn(mock)).catch((caught: unknown) => caught)
		expect(error).toBeInstanceOf(PveApiError)
		if (!(error instanceof PveApiError)) throw new Error('expected PveApiError')
		expect(error.message).toContain('not running')
	})
})

describe('waitForAgent', () => {
	test('resolves once ping answers', async () => {
		const mock = mockClient()
		mock.reply({ status: 500, body: '{"data":null,"message":"QEMU guest agent is not running"}' })
		mock.reply({ data: null })
		await waitForAgent(agentOn(mock), { initialDelayMs: 1, maxDelayMs: 1 })
		expect(mock.calls().map((call) => call.path)).toEqual([
			`/nodes/ms02-0078/qemu/${VMID}/agent/ping`,
			`/nodes/ms02-0078/qemu/${VMID}/agent/ping`,
		])
	})

	test('gives up with a timeout that names the VM', async () => {
		const mock = mockClient()
		mock.reply({ status: 500, body: '{"data":null,"message":"QEMU guest agent is not running"}' })
		const error = await waitForAgent(agentOn(mock), { timeoutMs: 0 }).catch(
			(caught: unknown) => caught,
		)
		expect(error).toBeInstanceOf(PveTimeoutError)
		if (!(error instanceof PveTimeoutError)) throw new Error('expected PveTimeoutError')
		expect(error.what).toBe(`the guest agent of VM ${VMID} to answer`)
	})

	test('rethrows a failure that is not the agent being down', async () => {
		const mock = mockClient()
		mock.reply({ status: 403, body: '{"data":null,"message":"Permission check failed"}' })
		const error = await waitForAgent(agentOn(mock)).catch((caught: unknown) => caught)
		expect(error).toBeInstanceOf(PveError)
		if (!(error instanceof PveError)) throw new Error('expected PveError')
		expect(error.kind).toBe('permission')
	})
})

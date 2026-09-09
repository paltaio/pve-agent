import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
	DarwinGuest,
	LinuxGuest,
	WindowsGuest,
	type AnyGuestOs,
	type PveVm,
} from '../../src/index.ts'
import {
	ensureRunning,
	LIVE,
	LIVE_ALL,
	liveSession,
	MACOS_VM,
	MINUTE,
	SCRATCH_PREFIX,
	TARGET_NODE,
	TARGET_VM,
	waitForAgent,
	WINDOWS_VM,
} from './support.ts'

const session = liveSession()

function linux(os: AnyGuestOs): LinuxGuest {
	if (os instanceof LinuxGuest) return os
	throw new Error(`VM ${os.vmid} runs ${os.os}, not linux`)
}

function windows(os: AnyGuestOs): WindowsGuest {
	if (os instanceof WindowsGuest) return os
	throw new Error(`VM ${os.vmid} runs ${os.os}, not windows`)
}

function darwin(os: AnyGuestOs): DarwinGuest {
	if (os instanceof DarwinGuest) return os
	throw new Error(`VM ${os.vmid} runs ${os.os}, not darwin`)
}

/** Boots a desktop VM that is normally off and waits for its agent. */
async function bootDesktop(vm: PveVm): Promise<void> {
	if ((await vm.status()).runState === 'stopped') await vm.start()
	await vm.waitFor('running', { timeoutMs: 2 * MINUTE })
	await waitForAgent(vm, 10 * MINUTE)
}

async function shutDown(vm: PveVm): Promise<void> {
	await vm.shutdown({ timeout: 300, forceStop: true })
	await vm.waitFor('stopped', { timeoutMs: 5 * MINUTE })
}

async function stopIfRunning(vm: PveVm): Promise<void> {
	if ((await vm.status()).runState === 'stopped') return
	await vm.stop()
	await vm.waitFor('stopped', { timeoutMs: 2 * MINUTE })
}

describe.skipIf(!LIVE)('guest os', () => {
	beforeAll(() => session.open(), MINUTE)
	afterAll(() => session.close(), MINUTE)

	describe('linux', () => {
		test(
			'the helper runs commands, moves files and describes the system',
			async () => {
				const vm = session.cluster().vm(TARGET_VM, TARGET_NODE)
				await ensureRunning(vm)
				const os = linux(await vm.os)

				expect(await os.output('id -u')).toMatch(/^\d+$/)
				const loop = await os.sh('for word in one two; do echo "$word"; done')
				expect(loop.exitCode).toBe(0)
				expect(loop.stdout.trim().split('\n')).toEqual(['one', 'two'])

				const file = `/tmp/${SCRATCH_PREFIX}os.txt`
				const content = `round trip ${Date.now()}\n`
				await os.writeFile(file, content)
				expect(await os.readFile(file)).toBe(content)
				expect(await os.exists(file)).toBe(true)
				await os.delete(file)
				expect(await os.exists(file)).toBe(false)

				expect(await os.hostname()).toBe('debian-vm')
				const info = await os.osInfo()
				expect(info.os).toBe('linux')
				expect(info.id).toBe('debian')
			},
			5 * MINUTE,
		)
	})

	describe.skipIf(!LIVE_ALL)(`windows VM ${WINDOWS_VM}`, () => {
		afterAll(() => stopIfRunning(session.cluster().vm(WINDOWS_VM, TARGET_NODE)), 5 * MINUTE)

		test(
			'boots, answers cmd and PowerShell, moves a file and shuts down',
			async () => {
				const vm = session.cluster().vm(WINDOWS_VM, TARGET_NODE)
				await bootDesktop(vm)
				const os = windows(await vm.os)

				expect((await os.output('echo %USERNAME%')).length).toBeGreaterThan(0)
				const caption = await os.powershell('(Get-CimInstance Win32_OperatingSystem).Caption')
				expect(caption.exitCode).toBe(0)
				expect(caption.stdout).toContain('Windows')

				const file = `C:\\Windows\\Temp\\${SCRATCH_PREFIX}os.txt`
				const content = `round trip ${Date.now()}`
				await os.writeFile(file, content)
				expect(await os.readFile(file)).toBe(content)
				await os.delete(file)
				expect(await os.exists(file)).toBe(false)
				expect(await os.exists('C:\\Windows')).toBe(true)

				await shutDown(vm)
				expect((await vm.status()).runState).toBe('stopped')
			},
			20 * MINUTE,
		)
	})

	describe.skipIf(!LIVE_ALL)(`macos VM ${MACOS_VM}`, () => {
		afterAll(() => stopIfRunning(session.cluster().vm(MACOS_VM, TARGET_NODE)), 5 * MINUTE)

		test(
			'boots, reports its version, moves a file and shuts down',
			async () => {
				const vm = session.cluster().vm(MACOS_VM, TARGET_NODE)
				await bootDesktop(vm)
				const os = darwin(await vm.os)

				expect(await os.output('sw_vers -productVersion')).toMatch(/^\d+(\.\d+)*$/)
				expect((await os.hostname()).length).toBeGreaterThan(0)

				const file = `/tmp/${SCRATCH_PREFIX}os.txt`
				const content = `round trip ${Date.now()}\n`
				await os.writeFile(file, content)
				expect(await os.readFile(file)).toBe(content)
				await os.delete(file)
				expect(await os.exists(file)).toBe(false)

				await shutDown(vm)
				expect((await vm.status()).runState).toBe('stopped')
			},
			20 * MINUTE,
		)
	})
})

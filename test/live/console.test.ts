import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { pixelAt, type GuestConsole, type PveVm, type VmKvm } from '../../src/index.ts'
import {
	ensureRunning,
	guestPassword,
	has,
	LIVE,
	liveSession,
	MINUTE,
	SECOND,
	TARGET_NODE,
	TARGET_SCREEN,
	TARGET_USER,
	TARGET_VM,
} from './support.ts'

const [DESKTOP_WIDTH = 0, DESKTOP_HEIGHT = 0] = TARGET_SCREEN.split('x').map(Number)
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const LOGIN_PROMPT = /login: ?$/
const SERIAL_GETTY = 'serial-getty@ttyS0.service'

const session = liveSession()
const vm = (): PveVm => session.cluster().vm(TARGET_VM, TARGET_NODE)
const kvm = (): VmKvm => vm().kvm

/** A getty started by hand does not survive a reboot; the agent starts it again. */
async function ensureSerialGetty(target: PveVm): Promise<void> {
	const state = await target.guest.exec(['systemctl', 'is-active', SERIAL_GETTY])
	if (state.stdout.trim() === 'active') return
	await target.guest.output(['systemctl', 'start', SERIAL_GETTY])
}

/** Gets the console to a login prompt, logging out a shell an earlier run left behind. */
async function reachLoginPrompt(serial: GuestConsole): Promise<void> {
	await serial.sendLine('')
	const screen = await serial.waitForText(/login:|\$ /, { timeoutMs: 30 * SECOND })
	const lastLine = screen.trimEnd().split('\n').at(-1) ?? ''
	if (!LOGIN_PROMPT.test(lastLine)) await serial.sendLine('exit')
	await serial.waitForPrompt({ pattern: LOGIN_PROMPT, timeoutMs: 30 * SECOND })
}

describe.skipIf(!LIVE || !has.targetVm)('console', () => {
	beforeAll(async () => {
		await session.open()
		await ensureRunning(vm())
	}, 5 * MINUTE)
	afterAll(async () => {
		await vm().closeSessions()
		await session.close()
	}, MINUTE)

	describe('kvm', () => {
		test(
			'wakes the display and captures screenshots at the desktop size',
			async () => {
				// Idle, the guest blanks its display and QEMU falls back to a 640x480
				// surface; a key press brings the desktop resolution back.
				await kvm().press('shift')
				const frame = await kvm().waitForScreen((snap) => snap.width === DESKTOP_WIDTH, {
					timeoutMs: 30 * SECOND,
				})
				expect(frame.height).toBe(DESKTOP_HEIGHT)

				const jpeg = await kvm().screenshot({ fresh: true })
				expect(jpeg.format).toBe('jpeg')
				expect(jpeg.width).toBe(DESKTOP_WIDTH)
				expect(jpeg.height).toBe(DESKTOP_HEIGHT)
				expect(jpeg.data.length).toBeGreaterThan(0)

				const png = await kvm().screenshot({ format: 'png' })
				expect(png.format).toBe('png')
				expect(png.width).toBe(DESKTOP_WIDTH)
				expect(png.data.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)).toBe(true)
			},
			2 * MINUTE,
		)

		test(
			'a pixel matcher matches the colour it reads back',
			async () => {
				const snap = await kvm().snapshot()
				const color = pixelAt(snap, 0, 0)
				const result = await kvm().match({ kind: 'pixel', x: 0, y: 0, color })
				expect(result.matched).toBe(true)
			},
			30 * SECOND,
		)

		test(
			'typing leaves no key held',
			async () => {
				await kvm().type('hello')
				expect((await kvm().session()).heldKeys).toEqual([])
				await kvm().press('escape')
			},
			30 * SECOND,
		)

		test(
			'a second session opens after the first is closed',
			async () => {
				const first = await kvm().session()
				await kvm().close()
				expect(first.connected).toBe(false)
				const second = await kvm().session()
				expect(second).not.toBe(first)
				expect(second.connected).toBe(true)
				expect((await kvm().snapshot()).width).toBeGreaterThan(0)
				await kvm().close()
			},
			MINUTE,
		)
	})

	describe('serial', () => {
		test(
			'logs in at the getty, runs a command and logs out',
			async () => {
				await ensureSerialGetty(vm())
				const serial = vm().console
				await reachLoginPrompt(serial)

				const shell = await serial.login(TARGET_USER, guestPassword(), {
					timeoutMs: 30 * SECOND,
				})
				expect(shell.trimEnd().endsWith('$')).toBe(true)

				await serial.sendLine('echo serial-ok-$((6*7))')
				await serial.waitForText(/^serial-ok-42$/m, { timeoutMs: 30 * SECOND })

				await serial.sendLine('exit')
				await serial.waitForPrompt({ pattern: LOGIN_PROMPT, timeoutMs: 30 * SECOND })
				await serial.close()
			},
			3 * MINUTE,
		)

		test(
			'a reopened console shows the login prompt again',
			async () => {
				const serial = vm().console
				await serial.sendLine('')
				const screen = await serial.waitForPrompt({
					pattern: LOGIN_PROMPT,
					timeoutMs: 30 * SECOND,
				})
				expect(screen).toMatch(/login:/)
				await serial.close()
			},
			MINUTE,
		)
	})
})

import { afterEach, describe, expect, test } from 'bun:test'
import { charToKeysym } from '../console/rfb.ts'
import { closeMockClients, formFields } from '../core/test-support/api-mock.ts'
import { clusterFixture, TERM_PROXY, VNC_PROXY, type FakeSocketOptions } from './test-support.ts'

afterEach(closeMockClients)

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function fixture(sockets: FakeSocketOptions = {}) {
	return clusterFixture({ node: 'ms01-0160', sockets })
}

describe('the kvm handle', () => {
	test('opens nothing until it is used and is the same object each time', () => {
		const { cluster, requests, vnc } = fixture()
		const vm = cluster.vm(9000)
		expect(vm.kvm).toBe(vm.kvm)
		expect(vm.console).toBe(vm.console)
		expect(requests).toEqual([])
		expect(vnc).toEqual([])
	})

	test('press connects on the first call and taps the key', async () => {
		const { cluster, reply, calls, urls, vnc } = fixture()
		reply({ data: VNC_PROXY })
		await cluster.vm(9000).kvm.press('enter')
		const proxy = calls()[0]
		if (!proxy) throw new Error('no vncproxy request')
		expect(proxy.path).toBe('/nodes/ms01-0160/qemu/9000/vncproxy')
		expect(formFields(proxy).get('websocket')).toBe('1')
		expect(formFields(proxy).get('generate-password')).toBe('1')
		expect(urls[0]).toBe(
			`wss://${new URL(cluster.client.baseUrl).host}/api2/json/nodes/ms01-0160/qemu/9000/vncwebsocket?port=5900&vncticket=VNCTICKET`,
		)
		const enter = charToKeysym('enter')
		expect(vnc[0]?.keyEvents).toEqual([
			[1, enter],
			[0, enter],
		])
	})

	test('type, keyDown and keyUp send key events through the shared session', async () => {
		const { cluster, reply, vnc } = fixture()
		reply({ data: VNC_PROXY })
		const kvm = cluster.vm(9000).kvm
		await kvm.type('A', { cps: 1000 })
		await kvm.keyDown('ctrl')
		await kvm.keyUp('ctrl')
		const shift = charToKeysym('shift')
		const ctrl = charToKeysym('ctrl')
		const a = charToKeysym('A')
		expect(vnc).toHaveLength(1)
		expect(vnc[0]?.keyEvents).toEqual([
			[1, shift],
			[1, a],
			[0, a],
			[0, shift],
			[1, ctrl],
			[0, ctrl],
		])
	})

	test('move, click and scroll send pointer events', async () => {
		const { cluster, reply, vnc } = fixture()
		reply({ data: VNC_PROXY })
		const kvm = cluster.vm(9000).kvm
		await kvm.move(1, 2)
		await kvm.click(3, 4)
		await kvm.scroll(5, 6, 'down', 1)
		expect(vnc[0]?.pointerEvents).toEqual([
			[0, 1, 2],
			[0, 3, 4],
			[1, 3, 4],
			[0, 3, 4],
			[16, 5, 6],
			[0, 5, 6],
		])
	})

	test('snapshot and screenshot hand back the current frame', async () => {
		const { cluster, reply } = fixture({ screen: { width: 80, height: 50 } })
		reply({ data: VNC_PROXY })
		const kvm = cluster.vm(9000).kvm
		const frame = await kvm.snapshot()
		expect([frame.width, frame.height]).toEqual([80, 50])
		const jpeg = await kvm.screenshot({ quality: 60 })
		expect([jpeg.format, jpeg.width, jpeg.height]).toEqual(['jpeg', 80, 50])
		expect(jpeg.data.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]))
		const png = await kvm.screenshot({ format: 'png' })
		expect(png.data.subarray(0, 8)).toEqual(PNG_SIGNATURE)
	})

	test('match and waitForScreen read the frame', async () => {
		const { cluster, reply } = fixture()
		reply({ data: VNC_PROXY })
		const kvm = cluster.vm(9000).kvm
		const black = await kvm.match({ kind: 'pixel', x: 0, y: 0, color: '#000000' })
		expect(black.matched).toBe(true)
		const white = await kvm.match({ kind: 'pixel', x: 0, y: 0, color: '#ffffff' })
		expect(white.matched).toBe(false)
		const frame = await kvm.waitForScreen((current) => current.width === 64, { timeoutMs: 100 })
		expect(frame.height).toBe(32)
	})

	test('close drops the session and the next call opens a new one', async () => {
		const { cluster, reply, calls, vnc } = fixture()
		reply({ data: VNC_PROXY })
		const kvm = cluster.vm(9000).kvm
		await kvm.press('enter')
		await kvm.close()
		expect(vnc[0]?.closes).toBe(1)
		reply({ data: VNC_PROXY })
		await kvm.press('enter')
		expect(vnc).toHaveLength(2)
		expect(calls()).toHaveLength(2)
	})
})

describe('the serial console handle', () => {
	test('sends lines and reads the screen back', async () => {
		const { cluster, reply, ptys } = fixture({
			pty: { onLine: (line) => (line === 'hostname' ? 'debian-vm\r\n$ ' : undefined) },
		})
		reply({ data: TERM_PROXY })
		const serial = cluster.vm(9000).console
		await serial.sendLine('hostname')
		const screen = await serial.waitForText(/debian-vm/, { timeoutMs: 1000 })
		expect(screen).toBe('hostname\ndebian-vm\n$')
		expect(await serial.screen()).toBe(screen)
		expect(await serial.readNew()).toContain('debian-vm')
		expect(await serial.readNew()).toBe('')
		expect(ptys).toHaveLength(1)
	})

	test('waitForPrompt resolves once the cursor line ends in a prompt', async () => {
		const { cluster, reply } = fixture({ pty: { banner: 'debian:~# ' } })
		reply({ data: TERM_PROXY })
		expect(await cluster.vm(9000).console.waitForPrompt({ timeoutMs: 1000 })).toBe('debian:~#')
	})

	test('login answers the getty and resolves at the shell prompt', async () => {
		const answers: Record<string, string> = {
			'': 'debian login: ',
			debian: 'Password: ',
			secret: '\r\ndebian@debian-vm:~$ ',
		}
		const { cluster, reply, ptys } = fixture({
			pty: { echo: false, onLine: (line) => answers[line] },
		})
		reply({ data: TERM_PROXY })
		const screen = await cluster.vm(9000).console.login('debian', 'secret', { timeoutMs: 1000 })
		expect(screen.endsWith('debian@debian-vm:~$')).toBe(true)
		expect(ptys[0]?.sent.slice(2)).toEqual(['0:1:\r', '0:7:debian\r', '0:7:secret\r'])
	})

	test('a container console asks termproxy without a serial port', async () => {
		const { cluster, reply, calls } = fixture()
		reply({ data: TERM_PROXY })
		await cluster.container(110, 'ms02-0078').console.screen()
		const request = calls()[0]
		if (!request) throw new Error('no termproxy request')
		expect(request.path).toBe('/nodes/ms02-0078/lxc/110/termproxy')
		expect(request.body).toBe('')
	})

	test('sendKey, write and resize go to the pty', async () => {
		const { cluster, reply, ptys } = fixture()
		reply({ data: TERM_PROXY })
		const serial = cluster.vm(9000).console
		await serial.write('ls')
		await serial.sendKey('ctrl-c')
		await serial.resize(100, 30)
		expect(ptys[0]?.sent.slice(2)).toEqual(['0:2:ls', '0:1:\x03', '1:100:30:'])
	})

	test('close drops the console and the next call opens a new one', async () => {
		const { cluster, reply, ptys } = fixture()
		reply({ data: TERM_PROXY })
		const serial = cluster.vm(9000).console
		await serial.screen()
		await serial.close()
		expect(ptys[0]?.closes).toBe(1)
		reply({ data: TERM_PROXY })
		await serial.screen()
		expect(ptys).toHaveLength(2)
	})
})

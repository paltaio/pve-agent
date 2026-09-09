/**
 * Logs into a Linux VM over its serial console, runs `uname -r` there and
 * prints the line the console rendered.
 *
 *   PVE_ENV_FILE=./pve.env PVE_TARGET_VMID=101 PVE_GUEST_USER=debian PVE_GUEST_PASSWORD=... \
 *     bun run examples/serial-console.ts
 *
 * Reads PVE_TARGET_VMID, a VM with `serial0: socket` in its config and a
 * getty on ttyS0 inside; it is started when stopped and left running.
 * PVE_GUEST_USER and PVE_GUEST_PASSWORD are the login. When the getty is
 * inactive after a reboot, the guest agent starts it.
 */

import pve, { PveVm } from '../src/index.ts'

const SECOND = 1000
const MINUTE = 60 * SECOND
const LOGIN_PROMPT = /login: ?$/
const SERIAL_GETTY = 'serial-getty@ttyS0.service'
const KERNEL_LINE = /^kernel=(\S+)$/m

function env(name: string, fallback?: string): string {
	const value = process.env[name] ?? fallback
	if (value === undefined) {
		console.error(`usage: ${name}=... PVE_ENV_FILE=./pve.env bun run examples/serial-console.ts`)
		process.exit(1)
	}
	return value
}

const TARGET_VMID = Number(env('PVE_TARGET_VMID'))
const USER = env('PVE_GUEST_USER')
const PASSWORD = env('PVE_GUEST_PASSWORD')

await using cluster = await pve.connect()

const vm = await cluster.guest(TARGET_VMID)
if (!(vm instanceof PveVm)) {
	console.error(`guest ${TARGET_VMID} is a container; PVE_TARGET_VMID names a VM`)
	process.exit(1)
}

const config = await vm.config()
if (config.raw['serial0'] === undefined) {
	console.error(`vm ${vm.vmid} has no serial0; add one with vm.configure({ serial0: 'socket' })`)
	process.exit(1)
}
console.log(`vm ${vm.vmid} on ${vm.node} serial0 ${config.raw['serial0']}`)

const status = await vm.status()
if (status.runState === 'paused') await vm.resume()
if (status.runState === 'stopped') await vm.start()
await vm.waitFor('running', { timeoutMs: 2 * MINUTE })

const serial = vm.console
await serial.sendLine('')
let screen: string
try {
	screen = await serial.waitForText(/login:|\$ /, { timeoutMs: 15 * SECOND })
} catch {
	// A reboot leaves the serial getty inactive on this guest; the agent
	// brings it back, and the getty prints a fresh prompt.
	await vm.waitForAgent({ timeoutMs: MINUTE })
	await vm.guest.output(['systemctl', 'start', SERIAL_GETTY])
	console.log(`started ${SERIAL_GETTY} through the agent`)
	screen = await serial.waitForText(/login:/, { timeoutMs: 30 * SECOND })
}
// A shell an earlier login left behind is logged out first.
const lastLine = screen.trimEnd().split('\n').at(-1) ?? ''
if (!LOGIN_PROMPT.test(lastLine)) await serial.sendLine('exit')
await serial.waitForPrompt({ pattern: LOGIN_PROMPT, timeoutMs: 30 * SECOND })

await serial.login(USER, PASSWORD, { timeoutMs: 30 * SECOND })
console.log(`logged in as ${USER}`)

await serial.sendLine('echo kernel=$(uname -r)')
const answer = await serial.waitForText(KERNEL_LINE, { timeoutMs: 30 * SECOND })
console.log(`uname -r ${KERNEL_LINE.exec(answer)?.[1] ?? '-'}`)

await serial.sendLine('exit')
await serial.waitForPrompt({ pattern: LOGIN_PROMPT, timeoutMs: 30 * SECOND })

await serial.close()
console.log('logged out')

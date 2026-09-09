/**
 * Logs into a Linux VM over its serial console, runs `uname -r` there and
 * prints the line the console rendered.
 *
 *   set -a; . ./pve.env; set +a
 *   PVE_ENV_FILE=./pve.env PVE_TARGET_VMID=100 PVE_GUEST_USER=debian bun run examples/serial-console.ts
 *
 * Reads PVE_TARGET_VMID, a VM with `serial0: socket` in its config and a
 * getty on ttyS0 inside; it is started when stopped and left running.
 * PVE_GUEST_USER and PVE_GUEST_PASSWORD are the login; put the password in
 * the env file and source it. A getty started by hand does not survive a
 * reboot, so when the console stays silent the guest agent starts the unit
 * again; enable the unit inside the guest to keep it.
 */

import pve from '../src/index.ts'
import { env, LOGIN_PROMPT, reachLoginPrompt, runningVm, SECOND } from './support.ts'

const KERNEL_LINE = /^kernel=(\S+)$/m

const TARGET_VMID = Number(env('PVE_TARGET_VMID'))
const USER = env('PVE_GUEST_USER')
const PASSWORD = env('PVE_GUEST_PASSWORD')

await using cluster = await pve.connect()

const vm = await runningVm(cluster, TARGET_VMID)
const config = await vm.config()
if (config.raw['serial0'] === undefined) {
	console.error(`vm ${vm.vmid} has no serial0; add one with vm.configure({ serial0: 'socket' })`)
	process.exit(1)
}
console.log(`vm ${vm.vmid} on ${vm.node} serial0 ${config.raw['serial0']}`)

await reachLoginPrompt(vm)
const serial = vm.console
await serial.login(USER, PASSWORD, { timeoutMs: 30 * SECOND })
console.log(`logged in as ${USER}`)

await serial.sendLine('echo kernel=$(uname -r)')
const answer = await serial.waitForText(KERNEL_LINE, { timeoutMs: 30 * SECOND })
console.log(`uname -r ${KERNEL_LINE.exec(answer)?.[1] ?? '-'}`)

await serial.sendLine('exit')
await serial.waitForPrompt({ pattern: LOGIN_PROMPT, timeoutMs: 30 * SECOND })

await serial.close()
console.log('logged out')

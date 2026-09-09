/**
 * Drives firmware over the VNC console of a VM with no disk and no OS: waits
 * for the SeaBIOS text screen, opens the boot menu with a key press, types
 * into it, and saves a screenshot of each stage. The frame is the only
 * signal, so every step waits on the screen rather than on a timer.
 *
 *   PVE_ENV_FILE=./pve.env bun run examples/install-over-kvm.ts
 *
 * Reads PVE_NODE (default: the PVE_NODE of the env file), PVE_VMID (default
 * 9011) and PVE_SHOT_DIR, the directory the PNGs land in (default: the
 * system temp directory). An example guest already holding PVE_VMID is
 * deleted first, and the VM is deleted before the script exits, after a
 * failure too.
 */

import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pve, { type PveVm } from '../src/index.ts'
import { env, EXAMPLE_PREFIX, MINUTE, removeGuest, SECOND } from './support.ts'

const SPLASH_ORANGE = '#e57000'

const VMID = Number(env('PVE_VMID', '9011'))
const SHOT_DIR = env('PVE_SHOT_DIR', tmpdir())

async function save(vm: PveVm, name: string): Promise<void> {
	const shot = await vm.kvm.screenshot({ format: 'png', fresh: true })
	const path = join(SHOT_DIR, `${name}.png`)
	await Bun.write(path, shot.data)
	console.log(`screenshot ${path} ${shot.width}x${shot.height} seq ${shot.seq}`)
}

await using cluster = await pve.connect()
const node = cluster.node(process.env['PVE_NODE']).name

await removeGuest(cluster, VMID)

const vm = await cluster.createVm({
	node,
	vmid: VMID,
	name: `${EXAMPLE_PREFIX}kvm`,
	memory: '512',
	cores: 1,
	ostype: 'l26',
})
console.log(`created ${vm.path}`)

try {
	await vm.start()
	await vm.waitFor('running', { timeoutMs: MINUTE })

	// With nothing to boot the firmware loops: the splash, the 720x400 text
	// screen saying no device is bootable, a reboot. The text screen is the
	// first stable frame.
	const firmware = await vm.kvm.waitForScreen(
		(frame) => frame.width === 720 && frame.height === 400,
		{ timeoutMs: 30 * SECOND },
	)
	console.log(`firmware text screen seq ${firmware.seq}`)
	await save(vm, 'kvm-01-firmware')

	// The firmware reads the keyboard while the splash is up, and the splash
	// is the only orange thing it paints.
	await vm.kvm.waitForScreen(
		{ kind: 'color', color: SPLASH_ORANGE, area: 0.002 },
		{ timeoutMs: 30 * SECOND },
	)
	await vm.kvm.press('escape')
	const menu = await vm.kvm.waitForScreen((frame) => frame.width === 720, {
		timeoutMs: 15 * SECOND,
	})
	console.log(`boot menu seq ${menu.seq}`)
	await vm.kvm.press('enter')
	await vm.kvm.type('1', { cps: 10 })
	await vm.kvm.waitForScreen(
		{ kind: 'changed', since: menu, area: 0.001 },
		{ timeoutMs: 15 * SECOND },
	)
	await save(vm, 'kvm-02-after-keys')

	const result = await vm.kvm.match(
		[
			{ kind: 'changed', since: firmware, area: 0.001 },
			{ kind: 'color', color: SPLASH_ORANGE, area: 0.002 },
		],
		{ match: 'any' },
	)
	console.log(`match ${result.matched} ${JSON.stringify(result.results)}`)

	await vm.kvm.close()
	await vm.stop()
	await vm.waitFor('stopped', { timeoutMs: MINUTE })
	console.log('stopped')
} finally {
	await removeGuest(cluster, VMID)
	console.log(`deleted ${VMID}`)
}

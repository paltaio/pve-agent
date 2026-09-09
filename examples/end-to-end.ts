/**
 * One pass over the library: cluster state, a scratch VM through create,
 * start, screenshot, snapshot, stop and delete, a scratch container through
 * create, exec and delete, a guest agent command and a serial login on a
 * running Linux VM, and a ZFS listing over the node shell. Prints one line
 * per step.
 *
 *   PVE_ENV_FILE=./pve.env PVE_STORAGE=local-zfs PVE_TARGET_VMID=101 \
 *     PVE_GUEST_USER=debian PVE_GUEST_PASSWORD=... bun run examples/end-to-end.ts
 *
 * Reads PVE_NODE (default: the PVE_NODE of the env file), PVE_STORAGE
 * (default local-zfs), PVE_TEMPLATE_STORAGE (default local), PVE_BRIDGE
 * (default vmbr1), PVE_VMID (scratch VM, default 9011), PVE_CT_VMID (scratch
 * container, default 9012), PVE_TARGET_VMID (a Linux VM with the guest agent
 * and a getty on serial0; started when stopped and left running),
 * PVE_GUEST_USER, PVE_GUEST_PASSWORD, and PVE_SHOT, a PNG path the
 * screenshot is written to when set. Guests already holding the scratch ids
 * are deleted first, and both are deleted before the script exits, after a
 * failure too. The container and the node shell need an SSH key for root on
 * the node, or a root@pam ticket in the env file.
 */

import pve, { PveNotFoundError, PveVm, type PveCluster, type VolumeEntry } from '../src/index.ts'

const SECOND = 1000
const MINUTE = 60 * SECOND
const LOGIN_PROMPT = /login: ?$/
const SERIAL_GETTY = 'serial-getty@ttyS0.service'

function env(name: string, fallback?: string): string {
	const value = process.env[name] ?? fallback
	if (value === undefined) {
		console.error(`usage: ${name}=... PVE_ENV_FILE=./pve.env bun run examples/end-to-end.ts`)
		process.exit(1)
	}
	return value
}

const STORAGE = env('PVE_STORAGE', 'local-zfs')
const TEMPLATE_STORAGE = env('PVE_TEMPLATE_STORAGE', 'local')
const BRIDGE = env('PVE_BRIDGE', 'vmbr1')
const VMID = Number(env('PVE_VMID', '9011'))
const CT_VMID = Number(env('PVE_CT_VMID', '9012'))
const TARGET_VMID = Number(env('PVE_TARGET_VMID'))
const USER = env('PVE_GUEST_USER')
const PASSWORD = env('PVE_GUEST_PASSWORD')
const SHOT = process.env['PVE_SHOT']

async function step<T>(
	name: string,
	run: () => Promise<T>,
	summary: (result: T) => string = String,
): Promise<T> {
	const started = Date.now()
	const result = await run()
	console.log(`${name}: ${summary(result)} (${Date.now() - started} ms)`)
	return result
}

async function removeGuest(cluster: PveCluster, vmid: number): Promise<void> {
	let guest
	try {
		guest = await cluster.guest(vmid)
	} catch (error) {
		if (error instanceof PveNotFoundError) return
		throw error
	}
	if ((await guest.status()).runState !== 'stopped') {
		await guest.stop()
		await guest.waitFor('stopped', { timeoutMs: 2 * MINUTE })
	}
	await guest.delete({ purge: true, 'destroy-unreferenced-disks': true })
}

await using cluster = await pve.connect()
const node = cluster.node(process.env['PVE_NODE'])

await step('cluster', async () => {
	const version = await cluster.version()
	const nodes = await cluster.nodes()
	const guests = await cluster.list()
	return `pve-manager ${version.version}, ${nodes.length} nodes, ${guests.length} guests`
})

await removeGuest(cluster, VMID)
await removeGuest(cluster, CT_VMID)
try {
	const vm = await step(
		'vm create',
		() =>
			cluster.createVm({
				node: node.name,
				vmid: VMID,
				name: 'pve-agent-example-vm',
				memory: '512',
				cores: 1,
				ostype: 'l26',
				scsihw: 'virtio-scsi-single',
				scsi0: `${STORAGE}:1`,
				net0: `virtio,bridge=${BRIDGE}`,
			}),
		(created) => created.path,
	)

	await step('vm start', async () => {
		await vm.start()
		return `pid ${(await vm.waitFor('running', { timeoutMs: MINUTE })).pid}`
	})

	await step('vm screenshot', async () => {
		// The firmware paints its 720x400 text screen a few seconds after the
		// start task ends.
		await vm.kvm.waitForScreen((frame) => frame.width === 720 && frame.height === 400, {
			timeoutMs: 30 * SECOND,
		})
		const shot = await vm.kvm.screenshot({ format: 'png', fresh: true })
		if (SHOT !== undefined) await Bun.write(SHOT, shot.data)
		await vm.kvm.close()
		return `${shot.width}x${shot.height} ${shot.data.length} bytes${SHOT === undefined ? '' : ` at ${SHOT}`}`
	})

	await step('vm snapshot', async () => {
		await vm.snapshot('s1')
		const names = (await vm.snapshots()).map((snapshot) => snapshot.name)
		await vm.deleteSnapshot('s1')
		return `took and deleted s1, list was ${names.join(' ')}`
	})

	await step('vm stop', async () => {
		await vm.stop()
		return (await vm.waitFor('stopped', { timeoutMs: MINUTE })).runState
	})

	await step('vm delete', async () => {
		await vm.delete({ purge: true })
		return `${VMID} gone`
	})

	let template: VolumeEntry | undefined
	for (const volume of await node.api.storage.content(TEMPLATE_STORAGE, { content: 'vztmpl' })) {
		if (!volume.volid.includes('alpine')) continue
		if (template === undefined || (volume.ctime ?? 0) > (template.ctime ?? 0)) template = volume
	}
	if (template === undefined)
		throw new Error(`no alpine template on ${TEMPLATE_STORAGE} of ${node.name}`)
	const ostemplate = template.volid

	const ct = await step(
		'ct create',
		() =>
			cluster.createContainer({
				node: node.name,
				vmid: CT_VMID,
				hostname: 'pve-agent-example-ct',
				ostemplate,
				rootfs: `${STORAGE}:1`,
				memory: 256,
				unprivileged: true,
				net0: `name=eth0,bridge=${BRIDGE}`,
			}),
		(created) => `${created.path} from ${ostemplate}`,
	)

	await step('ct exec', async () => {
		await ct.start()
		await ct.waitFor('running', { timeoutMs: MINUTE })
		const result = await ct.exec('cat /etc/alpine-release')
		return `alpine ${result.stdout.trim()} exit ${result.exitCode}`
	})

	await step('ct delete', async () => {
		await ct.stop()
		await ct.waitFor('stopped', { timeoutMs: MINUTE })
		await ct.delete({ purge: true })
		return `${CT_VMID} gone`
	})
} finally {
	await removeGuest(cluster, VMID)
	await removeGuest(cluster, CT_VMID)
}

const target = await cluster.guest(TARGET_VMID)
if (!(target instanceof PveVm)) {
	throw new Error(`guest ${TARGET_VMID} is a container; PVE_TARGET_VMID names a VM`)
}

await step('agent', async () => {
	const status = await target.status()
	if (status.runState === 'paused') await target.resume()
	if (status.runState === 'stopped') await target.start()
	await target.waitFor('running', { timeoutMs: 2 * MINUTE })
	await target.waitForAgent({ timeoutMs: 3 * MINUTE })
	return `vm ${target.vmid} ${await target.guest.output(['uname', '-r'])}`
})

await step('serial', async () => {
	const serial = target.console
	await serial.sendLine('')
	let screen: string
	try {
		screen = await serial.waitForText(/login:|\$ /, { timeoutMs: 15 * SECOND })
	} catch {
		// A reboot leaves the serial getty inactive on this guest; the agent
		// brings it back, and the getty prints a fresh prompt.
		await target.guest.output(['systemctl', 'start', SERIAL_GETTY])
		screen = await serial.waitForText(/login:/, { timeoutMs: 30 * SECOND })
	}
	const lastLine = screen.trimEnd().split('\n').at(-1) ?? ''
	if (!LOGIN_PROMPT.test(lastLine)) await serial.sendLine('exit')
	await serial.waitForPrompt({ pattern: LOGIN_PROMPT, timeoutMs: 30 * SECOND })
	await serial.login(USER, PASSWORD, { timeoutMs: 30 * SECOND })
	await serial.sendLine('echo serial-$((6*7))')
	await serial.waitForText(/^serial-42$/m, { timeoutMs: 30 * SECOND })
	await serial.sendLine('exit')
	await serial.waitForPrompt({ pattern: LOGIN_PROMPT, timeoutMs: 30 * SECOND })
	await serial.close()
	return `logged in as ${USER}, echoed serial-42, logged out`
})

await step('node shell', async () => {
	const shell = await node.shell
	const datasets = await shell.zfs.listDatasets({ depth: 0 })
	return `${shell.kind} on ${node.name}, ${datasets.length} pools: ${datasets.map((dataset) => dataset.name).join(' ')}`
})

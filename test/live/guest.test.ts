import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
	GuestCommandError,
	PveContainer,
	PveNotFoundError,
	PveVm,
	type PveCluster,
} from '../../src/index.ts'
import {
	alpineTemplate,
	ensureRunning,
	LIBRARY_CT,
	LIVE,
	liveSession,
	MINUTE,
	removeScratchGuest,
	SCRATCH_BRIDGE,
	SCRATCH_CT,
	SCRATCH_NODE,
	SCRATCH_PREFIX,
	SCRATCH_STORAGE,
	SCRATCH_VM,
	SECOND,
	TARGET_NODE,
	TARGET_VM,
} from './support.ts'

const session = liveSession()
const cluster = (): PveCluster => session.cluster()

async function removeScratchGuests(): Promise<void> {
	await removeScratchGuest(cluster(), SCRATCH_VM)
	await removeScratchGuest(cluster(), SCRATCH_CT)
}

describe.skipIf(!LIVE)('guest', () => {
	beforeAll(async () => {
		await session.open()
		await removeScratchGuests()
	}, 5 * MINUTE)
	afterAll(async () => {
		await removeScratchGuests()
		await session.close()
	}, 5 * MINUTE)

	test(
		'discovery finds the target VM and the library container',
		async () => {
			const guests = await cluster().list()
			const byVmid = new Map(guests.map((guest) => [guest.vmid, guest]))
			expect(byVmid.get(TARGET_VM)?.type).toBe('qemu')
			expect(byVmid.get(TARGET_VM)?.node).toBe(TARGET_NODE)
			expect(byVmid.get(LIBRARY_CT)?.type).toBe('lxc')

			const vm = await cluster().guest(TARGET_VM)
			expect(vm).toBeInstanceOf(PveVm)
			expect(vm.node).toBe(TARGET_NODE)
			const container = await cluster().guest(LIBRARY_CT)
			if (!(container instanceof PveContainer)) {
				throw new Error(`Guest ${LIBRARY_CT} is a ${container.type}, not a container`)
			}
			expect((await container.config()).hostname).toBe('image-library')
		},
		30 * SECOND,
	)

	test(
		'a scratch VM goes through create, start, snapshot, rollback and delete',
		async () => {
			const vm = await cluster().createVm({
				node: SCRATCH_NODE,
				vmid: SCRATCH_VM,
				name: `${SCRATCH_PREFIX}vm`,
				memory: '512',
				cores: 1,
				ostype: 'l26',
				scsihw: 'virtio-scsi-single',
				scsi0: `${SCRATCH_STORAGE}:1`,
				net0: `virtio,bridge=${SCRATCH_BRIDGE}`,
			})
			expect(vm.vmid).toBe(SCRATCH_VM)

			const created = await vm.config()
			expect(created.memory).toBe(512)
			expect(created.cores).toBe(1)
			const net0 = created.nets['net0']
			expect(net0?.['bridge']).toBe(SCRATCH_BRIDGE)
			expect(net0?.['model']).toBe('virtio')
			expect(net0?.['macaddr']).toMatch(/^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/)
			expect(created.disks['scsi0']?.['file']).toContain(`${SCRATCH_STORAGE}:`)

			await vm.start()
			expect((await vm.waitFor('running', { timeoutMs: MINUTE })).runState).toBe('running')

			await vm.snapshot('s1')
			expect((await vm.snapshots()).map((snapshot) => snapshot.name)).toContain('s1')

			await vm.configure({ memory: '768' })
			expect((await vm.config()).memory).toBe(768)

			await vm.rollback('s1')
			expect((await vm.config()).memory).toBe(512)

			await vm.deleteSnapshot('s1')
			expect((await vm.snapshots()).some((snapshot) => snapshot.name === 's1')).toBe(false)

			if ((await vm.status()).runState !== 'stopped') await vm.stop()
			await vm.waitFor('stopped', { timeoutMs: MINUTE })

			await vm.delete({ purge: true })
			await expect(cluster().guest(SCRATCH_VM)).rejects.toBeInstanceOf(PveNotFoundError)
		},
		10 * MINUTE,
	)

	test(
		'a scratch container goes through create, start, snapshot and delete',
		async () => {
			const container = await cluster().createContainer({
				node: SCRATCH_NODE,
				vmid: SCRATCH_CT,
				hostname: `${SCRATCH_PREFIX}ct`,
				ostemplate: await alpineTemplate(cluster()),
				rootfs: `${SCRATCH_STORAGE}:1`,
				memory: 256,
				unprivileged: true,
				net0: `name=eth0,bridge=${SCRATCH_BRIDGE}`,
			})
			expect(container.vmid).toBe(SCRATCH_CT)

			const created = await container.config()
			expect(created.memory).toBe(256)
			expect(created.unprivileged).toBe(true)
			expect(created.nets['net0']?.['bridge']).toBe(SCRATCH_BRIDGE)

			await container.start()
			expect((await container.waitFor('running', { timeoutMs: MINUTE })).runState).toBe('running')

			await container.snapshot('s1')
			expect((await container.snapshots()).map((snapshot) => snapshot.name)).toContain('s1')
			await container.deleteSnapshot('s1')
			expect((await container.snapshots()).some((snapshot) => snapshot.name === 's1')).toBe(false)

			await container.stop()
			await container.waitFor('stopped', { timeoutMs: MINUTE })

			await container.delete({ purge: true })
			await expect(cluster().guest(SCRATCH_CT)).rejects.toBeInstanceOf(PveNotFoundError)
		},
		10 * MINUTE,
	)

	test(
		'the guest agent of the target VM answers commands and file transfers',
		async () => {
			const vm = cluster().vm(TARGET_VM, TARGET_NODE)
			await ensureRunning(vm)
			const agent = vm.guest

			await agent.ping()
			expect((await agent.osInfo()).id).toBe('debian')
			expect(await agent.output(['uname', '-a'])).toContain('Linux')

			const failure = agent.output(['sh', '-c', 'exit 3'])
			await expect(failure).rejects.toBeInstanceOf(GuestCommandError)
			await failure.catch((error: unknown) => {
				if (error instanceof GuestCommandError) expect(error.exitCode).toBe(3)
			})

			const file = `/tmp/${SCRATCH_PREFIX}agent.txt`
			const content = `caf\u00e9 ${Date.now()}\n`
			await agent.fileWrite(file, content)
			const read = await agent.fileRead(file)
			expect(read.content).toBe(content)
			expect(read.truncated).toBe(false)
			await agent.output(['rm', file])
			const gone = await agent.exec(['test', '-e', file])
			expect(gone.exitCode).toBe(1)
		},
		5 * MINUTE,
	)
})

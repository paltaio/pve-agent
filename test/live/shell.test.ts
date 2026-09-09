import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	NodeShell,
	PveShellCommandError,
	PveShellPolicyError,
	PveShellTimeoutError,
	shQuote,
	spawnProcess,
	type PveCluster,
	type SpawnRequest,
} from '../../src/index.ts'
import {
	alpineTemplate,
	CLUSTER_VERSION,
	has,
	hasScratchCt,
	LIBRARY_CT,
	LIVE,
	liveSession,
	MINUTE,
	removeScratchGuest,
	SCRATCH_BRIDGE,
	SCRATCH_CT,
	SCRATCH_NODE,
	SCRATCH_POOL,
	SCRATCH_PREFIX,
	SCRATCH_STORAGE,
	SECOND,
	TARGET_NODE,
	TARGET_VM,
} from './support.ts'

const TEST_DATASET = `${SCRATCH_POOL}/pve-agent-test`

const session = liveSession()
const cluster = (): PveCluster => session.cluster()
const shell = (): Promise<NodeShell> => cluster().node(SCRATCH_NODE).shell

/** A second shell on the scratch node whose policy lets `zfs destroy` through. */
let destructive: NodeShell | undefined

async function destructiveShell(): Promise<NodeShell> {
	destructive ??= await NodeShell.open({ node: SCRATCH_NODE, policy: { destructive: 'allow' } })
	return destructive
}

async function removeTestDataset(): Promise<void> {
	if (!has.pool) return
	const datasets = await (await shell()).zfs.listDatasets({ target: SCRATCH_POOL, depth: 1 })
	if (!datasets.some((dataset) => dataset.name === TEST_DATASET)) return
	await (await destructiveShell()).zfs.destroyDataset(TEST_DATASET, { recursive: true })
}

describe.skipIf(!LIVE || !has.scratchNode)('shell', () => {
	beforeAll(async () => {
		await session.open()
		await removeTestDataset()
		await removeScratchGuest(cluster(), SCRATCH_CT)
	}, 5 * MINUTE)
	afterAll(async () => {
		await removeScratchGuest(cluster(), SCRATCH_CT)
		await removeTestDataset()
		await destructive?.close()
		await session.close()
	}, 5 * MINUTE)

	test(
		'output runs a command as root over ssh',
		async () => {
			const node = await shell()
			expect(node.kind).toBe('ssh')
			expect(await node.output('pveversion')).toContain(CLUSTER_VERSION)
		},
		MINUTE,
	)

	test(
		'a failing command reports its exit code, or throws when checked',
		async () => {
			const node = await shell()
			const result = await node.run('echo boom >&2; exit 2', { check: false })
			expect(result.exitCode).toBe(2)
			expect(result.stderr.trim()).toBe('boom')
			await expect(node.run('echo boom >&2; exit 2', { check: true })).rejects.toBeInstanceOf(
				PveShellCommandError,
			)
		},
		MINUTE,
	)

	test(
		'a command past its deadline throws PveShellTimeoutError',
		async () => {
			const node = await shell()
			await expect(node.run('sleep 30', { timeoutMs: 2 * SECOND })).rejects.toBeInstanceOf(
				PveShellTimeoutError,
			)
		},
		MINUTE,
	)

	test(
		'upload and download round-trip random bytes',
		async () => {
			const node = await shell()
			const bytes = crypto.getRandomValues(new Uint8Array(100))
			const localDir = await mkdtemp(join(tmpdir(), 'pve-agent-live-'))
			const remotePath = `/tmp/${SCRATCH_PREFIX}${process.pid}.bin`
			try {
				await writeFile(join(localDir, 'up.bin'), bytes)
				await node.upload(join(localDir, 'up.bin'), remotePath)
				await node.download(remotePath, join(localDir, 'down.bin'))
				expect(new Uint8Array(await readFile(join(localDir, 'down.bin')))).toEqual(bytes)
			} finally {
				await node.run(`rm -- ${shQuote(remotePath)}`)
				await rm(localDir, { recursive: true, force: true })
			}
			expect((await node.run(`test -e ${shQuote(remotePath)}`)).exitCode).toBe(1)
		},
		MINUTE,
	)

	test(
		'a destructive command is refused by the policy before anything is spawned',
		async () => {
			const spawned: SpawnRequest[] = []
			const watched = await NodeShell.open({
				node: SCRATCH_NODE,
				ssh: {
					spawn: (request) => {
						spawned.push(request)
						return spawnProcess(request)
					},
				},
			})
			try {
				spawned.length = 0
				await expect(watched.run('zfs destroy nosuchpool/nosuchset')).rejects.toBeInstanceOf(
					PveShellPolicyError,
				)
				expect(spawned).toEqual([])
			} finally {
				await watched.close()
			}
		},
		MINUTE,
	)

	test.skipIf(!has.pool)(
		'zfs lists the pool, then creates, snapshots and destroys a dataset',
		async () => {
			const node = await shell()
			expect((await node.zfs.listPools()).map((pool) => pool.name)).toContain(SCRATCH_POOL)

			await node.zfs.createDataset(TEST_DATASET)
			await node.zfs.snapshot(`${TEST_DATASET}@s1`)
			const snapshots = await node.zfs.listSnapshots(TEST_DATASET)
			expect(snapshots.map((snapshot) => snapshot.name)).toContain(`${TEST_DATASET}@s1`)

			await expect(
				node.zfs.destroyDataset(TEST_DATASET, { recursive: true }),
			).rejects.toBeInstanceOf(PveShellPolicyError)
			await (await destructiveShell()).zfs.destroyDataset(TEST_DATASET, { recursive: true })

			const remaining = await node.zfs.listDatasets({ target: SCRATCH_POOL, depth: 1 })
			expect(remaining.some((dataset) => dataset.name === TEST_DATASET)).toBe(false)
		},
		2 * MINUTE,
	)

	test(
		'systemd reports the status daemon and its journal',
		async () => {
			const node = await shell()
			const status = await node.systemd.status('pvestatd')
			expect(status.activeState).toBe('active')
			expect(status.mainPid).toBeGreaterThan(0)
			const lines = await node.systemd.journal({ unit: 'pvestatd', lines: 5 })
			expect(lines.length).toBeGreaterThan(0)
			expect(lines.length).toBeLessThanOrEqual(5)
		},
		MINUTE,
	)

	test(
		'apt shows the manager package',
		async () => {
			const node = await shell()
			const stanzas = await node.apt.show('pve-manager')
			expect(stanzas.length).toBeGreaterThan(0)
			expect(stanzas[0]?.['Package']).toBe('pve-manager')
			expect(stanzas[0]?.['Version']).toMatch(/^\d+\.\d+/)
			expect(await node.apt.installedVersion('pve-manager')).toContain(CLUSTER_VERSION)
		},
		MINUTE,
	)

	test.skipIf(!has.targetVm || !has.libraryCt)(
		'qm and pct see the target guests on their node',
		async () => {
			const node = await cluster().node(TARGET_NODE).shell
			const vms = await node.qm.list()
			expect(vms.map((entry) => entry.vmid)).toContain(TARGET_VM)
			const config = await node.qm.config(TARGET_VM)
			expect(config['name']).toBe((await cluster().vm(TARGET_VM, TARGET_NODE).config()).name)
			const containers = await node.pct.list()
			expect(containers.map((entry) => entry.vmid)).toContain(LIBRARY_CT)
		},
		MINUTE,
	)

	test.skipIf(!hasScratchCt)(
		'pct exec, push, pull and df on a scratch container',
		async () => {
			const container = await cluster().createContainer({
				node: SCRATCH_NODE,
				vmid: SCRATCH_CT,
				hostname: `${SCRATCH_PREFIX}ct`,
				ostemplate: alpineTemplate(),
				rootfs: `${SCRATCH_STORAGE}:1`,
				memory: 256,
				unprivileged: true,
				net0: `name=eth0,bridge=${SCRATCH_BRIDGE}`,
			})
			const node = await shell()
			await node.pct.start(SCRATCH_CT)
			expect(await node.pct.status(SCRATCH_CT)).toBe('running')

			const release = await node.pct.exec(SCRATCH_CT, 'cat /etc/alpine-release')
			expect(release.exitCode).toBe(0)
			expect(release.stdout.trim()).toMatch(/^\d+\.\d+/)

			const localDir = await mkdtemp(join(tmpdir(), 'pve-agent-live-'))
			try {
				const content = `pct round trip ${Date.now()}\n`
				await writeFile(join(localDir, 'push.txt'), content)
				await node.pct.pushLocalFile(SCRATCH_CT, join(localDir, 'push.txt'), '/root/round-trip.txt')
				await node.pct.pullToLocalFile(
					SCRATCH_CT,
					'/root/round-trip.txt',
					join(localDir, 'pull.txt'),
				)
				expect(await readFile(join(localDir, 'pull.txt'), 'utf8')).toBe(content)
			} finally {
				await rm(localDir, { recursive: true, force: true })
			}

			const usage = await node.pct.df(SCRATCH_CT)
			expect(usage.some((row) => row.mountPoint === 'rootfs')).toBe(true)

			await node.pct.stop(SCRATCH_CT)
			expect(await node.pct.status(SCRATCH_CT)).toBe('stopped')
			await container.delete({ purge: true })
			expect((await node.pct.list()).some((entry) => entry.vmid === SCRATCH_CT)).toBe(false)
		},
		10 * MINUTE,
	)
})

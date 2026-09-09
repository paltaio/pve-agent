import { describe, expect, test } from 'bun:test'
import { PveContainer, PveVm } from '../../src/index.ts'
import {
	CLUSTER_VERSION,
	connectLive,
	has,
	LIBRARY_CT,
	LIVE,
	MINUTE,
	SCRATCH_NODE,
	SCRATCH_PREFIX,
	SECOND,
	TARGET_VM,
} from './support.ts'

const API_PORT = 8006
const HAS_SS = Bun.which('ss') !== null

/** Established TCP connections from this process to the API port, as `ss` reports them. */
async function apiConnections(): Promise<string[]> {
	const proc = Bun.spawn(['ss', '-tnp', 'state', 'established'], { stdout: 'pipe', stderr: 'pipe' })
	const output = await new Response(proc.stdout).text()
	await proc.exited
	return output
		.split('\n')
		.filter((line) => line.includes(`:${API_PORT} `) && line.includes(`pid=${process.pid},`))
}

describe.skipIf(!LIVE)('facade', () => {
	test.skipIf(!has.scratchNode || !has.targetVm || !has.libraryCt)(
		'a cluster opened with await using reaches nodes, guests, notes and a node shell',
		async () => {
			await using cluster = await connectLive()

			expect((await cluster.version()).version).toBe(CLUSTER_VERSION)
			expect((await cluster.nodes()).map((entry) => entry.node)).toContain(SCRATCH_NODE)

			const vmids = (await cluster.list()).map((guest) => guest.vmid)
			expect(vmids).toContain(TARGET_VM)
			expect(vmids).toContain(LIBRARY_CT)

			const vm = await cluster.guest(TARGET_VM)
			expect(vm).toBeInstanceOf(PveVm)
			const container = await cluster.guest(LIBRARY_CT)
			expect(container).toBeInstanceOf(PveContainer)

			const before = await vm.notes()
			const marker = `${SCRATCH_PREFIX}notes ${Date.now()}`
			try {
				await vm.setNotes(marker)
				expect(await vm.notes()).toBe(marker)
			} finally {
				if (before === undefined) await vm.api.deleteConfigKeys('description')
				else await vm.setNotes(before)
			}
			expect(await vm.notes()).toBe(before)

			const shell = await cluster.node(SCRATCH_NODE).shell
			expect(await shell.output('hostname')).toBe(SCRATCH_NODE)
		},
		3 * MINUTE,
	)

	test.skipIf(!HAS_SS || !has.scratchNode)(
		'close drops every connection to the API port',
		async () => {
			const cluster = await connectLive()
			await cluster.version()
			await (await cluster.node(SCRATCH_NODE).shell).output('true')
			expect((await apiConnections()).length).toBeGreaterThan(0)

			await cluster.close()

			const deadline = Date.now() + 5 * SECOND
			let open = await apiConnections()
			while (open.length > 0 && Date.now() < deadline) {
				await Bun.sleep(250)
				open = await apiConnections()
			}
			expect(open).toEqual([])
		},
		2 * MINUTE,
	)
})

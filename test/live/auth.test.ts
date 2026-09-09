import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
	PveNotFoundError,
	PveTierError,
	type PveVersion,
	type RequestTrace,
} from '../../src/index.ts'
import {
	CLUSTER_VERSION,
	has,
	LIVE,
	liveSession,
	MINUTE,
	SCRATCH_NODE,
	SCRATCH_PREFIX,
	SECOND,
	TARGET_NODE,
	TARGET_VM,
} from './support.ts'

const EXECUTE_PATH = `/nodes/${SCRATCH_NODE}/execute`
const UNKNOWN_VMID = 9999

const traces: RequestTrace[] = []
const session = liveSession({ onRequest: (trace) => traces.push(trace) })

describe.skipIf(!LIVE)('auth', () => {
	beforeAll(() => session.open(), MINUTE)
	afterAll(() => session.close(), MINUTE)

	test(
		'the ticket tier logs in as the env user',
		async () => {
			const auth = session.cluster().client.auth
			const ticket = await auth.getTicket()
			expect(auth.ticketUsername).toBeDefined()
			expect(ticket.username).toBe(auth.ticketUsername ?? '')
			expect(ticket.ticket.startsWith('PVE:')).toBe(true)
			expect(ticket.csrfToken.length).toBeGreaterThan(0)
		},
		30 * SECOND,
	)

	test(
		'GET /version answers on the token and on the ticket',
		async () => {
			const client = session.cluster().client
			const byToken = await client.get<PveVersion>('/version', undefined, { tier: 'token' })
			const byTicket = await client.get<PveVersion>('/version', undefined, { tier: 'ticket' })
			expect(byToken.version).toBe(CLUSTER_VERSION)
			expect(byTicket.version).toBe(CLUSTER_VERSION)
		},
		30 * SECOND,
	)

	test(
		'a root-only endpoint is refused before any request goes out',
		async () => {
			const client = session.cluster().client
			const decision = client.requiredTier('POST', EXECUTE_PATH)
			expect(decision.tier).toBe('ticket')
			expect(decision.requiresRootPam).toBe(true)

			traces.length = 0
			await expect(client.post(EXECUTE_PATH, { commands: '[]' })).rejects.toBeInstanceOf(
				PveTierError,
			)
			expect(traces.filter((trace) => trace.path === EXECUTE_PATH)).toEqual([])
		},
		30 * SECOND,
	)

	test.skipIf(!has.scratchNode)(
		'the config of an unknown vmid is a PveNotFoundError',
		async () => {
			const vm = session.cluster().vm(UNKNOWN_VMID, SCRATCH_NODE)
			await expect(vm.config()).rejects.toBeInstanceOf(PveNotFoundError)
		},
		30 * SECOND,
	)

	test.skipIf(!has.targetVm)(
		'an async config write returns a UPID with a status and a log',
		async () => {
			const cluster = session.cluster()
			const vm = cluster.vm(TARGET_VM, TARGET_NODE)
			const before = await vm.notes()
			const upid = await vm.api.setConfigAsync({ description: `${SCRATCH_PREFIX}description` })
			try {
				expect(upid.startsWith('UPID:')).toBe(true)
				const status = await cluster.waitForTask(upid)
				expect(status.exitStatus).toBe('OK')
				expect(status.outcome).toBe('ok')
				expect((await cluster.client.taskLog(upid)).length).toBeGreaterThan(0)
			} finally {
				if (before === undefined) await vm.api.deleteConfigKeys('description')
				else await vm.setNotes(before)
			}
			expect(await vm.notes()).toBe(before)
		},
		MINUTE,
	)
})

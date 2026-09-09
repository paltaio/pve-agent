import { afterEach, describe, expect, test } from 'bun:test'
import { PveConfigError, PveTaskError } from './errors.ts'
import {
	getTaskLog,
	getTaskStatus,
	isUpid,
	normalizeTaskListEntry,
	parseUpid,
	stopTask,
	taskOutcome,
	waitForTask,
} from './tasks.ts'
import { closeMockClients, mockClient, type MockClient } from './test-support/api-mock.ts'

afterEach(closeMockClients)

const UPID = 'UPID:ms01-0160:0007A1F2:0121C6B4:65F4A0E2:qmstart:110:agents@pve!ci:'
const STATUS_PATH =
	'/nodes/ms01-0160/tasks/UPID%3Ams01-0160%3A0007A1F2%3A0121C6B4%3A65F4A0E2%3Aqmstart%3A110%3Aagents%40pve!ci%3A'

describe('parseUpid', () => {
	test('reads every field', () => {
		expect(parseUpid(UPID)).toEqual({
			node: 'ms01-0160',
			pid: 0x0007a1f2,
			pstart: 0x0121c6b4,
			startTime: 0x65f4a0e2,
			type: 'qmstart',
			id: '110',
			user: 'agents@pve!ci',
			upid: UPID,
		})
	})

	test('takes a nine digit pstart, which a long uptime produces', () => {
		const long = 'UPID:pve:00000001:1121C6B44:65F4A0E2:vzdump::root@pam:'
		expect(parseUpid(long).pstart).toBe(0x1121c6b44)
		expect(parseUpid(long).id).toBe('')
	})

	test('rejects anything else', () => {
		expect(isUpid('UPID:pve:x:y:z:t:i:u:')).toBe(false)
		expect(isUpid(UPID.slice(0, -1))).toBe(false)
		expect(isUpid(42)).toBe(false)
		expect(isUpid(UPID)).toBe(true)
		// A malformed string is a bad argument, not a task that failed.
		expect(() => parseUpid('not a upid')).toThrow(PveConfigError)
	})
})

describe('taskOutcome', () => {
	test('separates success, warnings and failure', () => {
		expect(taskOutcome('OK')).toBe('ok')
		expect(taskOutcome('WARNINGS: 3')).toBe('warning')
		expect(taskOutcome('command failed with exit code 1')).toBe('error')
		expect(taskOutcome('unexpected status')).toBe('unknown')
		expect(taskOutcome(null)).toBe('unknown')
	})
})

describe('normalizeTaskListEntry', () => {
	test('moves the exit status out of status and derives the run state', () => {
		const finished = normalizeTaskListEntry({
			upid: UPID,
			node: 'ms01-0160',
			type: 'qmstart',
			id: '110',
			user: 'agents@pve!ci',
			pid: 499186,
			starttime: 1710596322,
			endtime: 1710596330,
			status: 'WARNINGS: 1',
		})
		expect(finished).toMatchObject({
			upid: UPID,
			node: 'ms01-0160',
			pid: 499186,
			startTime: 1710596322,
			endTime: 1710596330,
			status: 'stopped',
			exitStatus: 'WARNINGS: 1',
			outcome: 'warning',
		})
		expect(finished.raw['status']).toBe('WARNINGS: 1')

		const running = normalizeTaskListEntry({
			upid: UPID,
			node: 'ms01-0160',
			starttime: '1710596322',
		})
		expect(running.status).toBe('running')
		expect(running.exitStatus).toBeNull()
		expect(running.outcome).toBe('unknown')
		expect(running.pid).toBeUndefined()
		expect(running.startTime).toBe(1710596322)
	})
})

function queueStatuses(
	mock: MockClient,
	statuses: { status: string; exitstatus?: string }[],
): void {
	for (const status of statuses) mock.reply({ data: { upid: UPID, node: 'ms01-0160', ...status } })
}

describe('getTaskStatus', () => {
	test('asks the node named in the UPID and fills gaps from it', async () => {
		const mock = mockClient()
		mock.reply({ data: { status: 'running', pid: '499186' } })
		const status = await getTaskStatus(mock.client, UPID)
		expect(mock.last().path).toBe(`${STATUS_PATH}/status`)
		expect(status).toEqual({
			upid: UPID,
			node: 'ms01-0160',
			type: 'qmstart',
			id: '110',
			user: 'agents@pve!ci',
			pid: 499186,
			startTime: 0x65f4a0e2,
			status: 'running',
			exitStatus: null,
			outcome: 'unknown',
		})
	})
})

describe('waitForTask', () => {
	test('polls until the task stops', async () => {
		const mock = mockClient()
		queueStatuses(mock, [
			{ status: 'running' },
			{ status: 'running' },
			{ status: 'stopped', exitstatus: 'OK' },
		])
		const status = await waitForTask(mock.client, UPID, { initialDelayMs: 1, maxDelayMs: 1 })
		expect(status.outcome).toBe('ok')
		expect(status.exitStatus).toBe('OK')
		expect(mock.requests).toHaveLength(3)
	})

	test('reports the real exit status and the tail of the log', async () => {
		const mock = mockClient()
		queueStatuses(mock, [{ status: 'stopped', exitstatus: 'no such volume' }])
		mock.reply({
			data: [
				{ n: 1, t: 'starting' },
				{ n: 2, t: 'TASK ERROR: no such volume' },
			],
		})
		const error = await waitForTask(mock.client, UPID, { errorLogLines: 1 }).catch(
			(e: unknown) => e,
		)
		expect(error).toBeInstanceOf(PveTaskError)
		expect(error).toMatchObject({
			upid: UPID,
			exitStatus: 'no such volume',
			timedOut: false,
			log: ['TASK ERROR: no such volume'],
		})
		expect(error).toHaveProperty('message', expect.stringContaining('no such volume'))
		expect(mock.last().path).toBe(`${STATUS_PATH}/log?start=0&limit=0`)
	})

	test('errorLogLines: 0 attaches no log and reads none', async () => {
		const mock = mockClient()
		queueStatuses(mock, [{ status: 'stopped', exitstatus: 'no such volume' }])
		const error = await waitForTask(mock.client, UPID, { errorLogLines: 0 }).catch(
			(e: unknown) => e,
		)
		expect(error).toMatchObject({ upid: UPID, log: [] })
		expect(mock.last().path).toBe(`${STATUS_PATH}/status`)
	})

	test('still throws when the log is gone', async () => {
		const mock = mockClient()
		queueStatuses(mock, [{ status: 'stopped', exitstatus: 'unexpected status' }])
		mock.reply({ status: 500, body: '{"data":null,"message":"no such task"}' })
		const error = await waitForTask(mock.client, UPID).catch((e: unknown) => e)
		expect(error).toBeInstanceOf(PveTaskError)
		expect(error).toHaveProperty('log', [])
	})

	test('treats warnings as success unless asked not to', async () => {
		const warned = mockClient()
		queueStatuses(warned, [{ status: 'stopped', exitstatus: 'WARNINGS: 2' }])
		expect((await waitForTask(warned.client, UPID)).outcome).toBe('warning')

		const strict = mockClient()
		queueStatuses(strict, [{ status: 'stopped', exitstatus: 'WARNINGS: 2' }])
		await expect(waitForTask(strict.client, UPID, { failOnWarnings: true })).rejects.toThrow(
			/WARNINGS: 2/,
		)
	})

	test('gives up after the timeout with timedOut set and no exit status', async () => {
		const mock = mockClient()
		queueStatuses(
			mock,
			Array.from({ length: 50 }, () => ({ status: 'running' })),
		)
		const error = await waitForTask(mock.client, UPID, {
			timeoutMs: 5,
			initialDelayMs: 1,
			maxDelayMs: 1,
		}).catch((e: unknown) => e)
		expect(error).toBeInstanceOf(PveTaskError)
		expect(error).toMatchObject({ upid: UPID, timedOut: true, exitStatus: null })
		expect(error).toHaveProperty('message', expect.stringContaining('still running after'))
	})

	test('reports every poll', async () => {
		const mock = mockClient()
		queueStatuses(mock, [{ status: 'running' }, { status: 'stopped', exitstatus: 'OK' }])
		const seen: string[] = []
		await waitForTask(mock.client, UPID, {
			initialDelayMs: 1,
			onPoll: (status) => seen.push(status.status),
		})
		expect(seen).toEqual(['running', 'stopped'])
	})

	// Without this the wait only reacts to an abort while it sleeps, so a caller
	// who cancels mid-poll waits out the HTTP timeout.
	test('an abort lands during the status request', async () => {
		const mock = mockClient()
		mock.reply({ delayMs: 5_000, data: { status: 'running' } })
		const controller = new AbortController()
		const wait = waitForTask(mock.client, UPID, { signal: controller.signal })
		setTimeout(() => controller.abort(new Error('cancelled')), 20)
		const started = Date.now()
		await expect(wait).rejects.toThrow('cancelled')
		expect(Date.now() - started).toBeLessThan(1_000)
	})

	test('backs off between polls', async () => {
		const mock = mockClient()
		queueStatuses(mock, [
			{ status: 'running' },
			{ status: 'running' },
			{ status: 'running' },
			{ status: 'stopped', exitstatus: 'OK' },
		])
		const started = Date.now()
		await waitForTask(mock.client, UPID, { initialDelayMs: 10, maxDelayMs: 100 })
		// 10 + 20 + 40 ms of sleeping, with room for scheduling jitter.
		expect(Date.now() - started).toBeGreaterThanOrEqual(60)
	})
})

describe('getTaskLog', () => {
	test('reads the whole log unless a limit is given', async () => {
		const mock = mockClient()
		mock.reply({ data: [{ n: 1, t: 'line' }] })
		await expect(getTaskLog(mock.client, UPID)).resolves.toEqual(['line'])
		expect(mock.last().path).toBe(`${STATUS_PATH}/log?start=0&limit=0`)

		mock.reply({ data: [] })
		await getTaskLog(mock.client, UPID, { start: 10, limit: 5 })
		expect(mock.last().path).toBe(`${STATUS_PATH}/log?start=10&limit=5`)
	})
})

describe('stopTask', () => {
	test('deletes the task on its node', async () => {
		const mock = mockClient()
		await stopTask(mock.client, UPID)
		expect(mock.last().method).toBe('DELETE')
		expect(mock.last().path).toBe(STATUS_PATH)
	})
})

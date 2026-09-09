import { afterEach, describe, expect, test } from 'bun:test'
import { PveTimeoutError } from '../core/errors.ts'
import { closeMockClients, formObject, mockClient } from '../core/test-support/api-mock.ts'
import { destroyGuest, getStatus, powerAction, waitForRunState } from './lifecycle.ts'

afterEach(closeMockClients)

const ref = { type: 'qemu', node: 'ms01-0160', vmid: 9000 } as const

describe('status and power', () => {
	test('getStatus reads status/current into a normalized row', async () => {
		const mock = mockClient()
		mock.reply({ data: { status: 'running', qmpstatus: 'running', agent: 1, uptime: 12 } })
		const status = await getStatus(mock.client, ref)
		expect(mock.last().path).toBe('/nodes/ms01-0160/qemu/9000/status/current')
		expect(status).toMatchObject({
			runState: 'running',
			agentEnabled: true,
			uptime: 12,
			vmid: 9000,
		})
	})

	test('powerAction posts to the action path and hands back the UPID', async () => {
		const mock = mockClient()
		mock.reply({ data: 'UPID:ms01:00000001:00000001:00000001:qmstart:9000:agents@pve:' })
		const upid = await powerAction(mock.client, ref, 'shutdown', { forceStop: true, timeout: 60 })
		expect([mock.last().method, mock.last().path]).toEqual([
			'POST',
			'/nodes/ms01-0160/qemu/9000/status/shutdown',
		])
		expect(formObject(mock.last())).toEqual({ forceStop: '1', timeout: '60' })
		expect(upid).toMatch(/^UPID:/)
	})

	test('destroyGuest puts its parameters in the query string, never in a body', async () => {
		// The node answers "Unexpected content for method 'DELETE'" to a form body.
		const mock = mockClient()
		await destroyGuest(mock.client, ref, { purge: true, 'destroy-unreferenced-disks': true })
		expect([mock.last().method, mock.last().path]).toEqual([
			'DELETE',
			'/nodes/ms01-0160/qemu/9000?purge=1&destroy-unreferenced-disks=1',
		])
		expect(mock.last().body).toBe('')
	})
})

describe('waitForRunState', () => {
	test('returns once the guest reaches the state', async () => {
		const mock = mockClient()
		mock.reply({ data: { status: 'stopped' } })
		mock.reply({ data: { status: 'stopped' } })
		mock.reply({ data: { status: 'running' } })
		const status = await waitForRunState(mock.client, ref, 'running', { initialDelayMs: 1 })
		expect(status.runState).toBe('running')
		expect(mock.calls()).toHaveLength(3)
	})

	test('names the state the guest was actually in when it times out', async () => {
		const mock = mockClient()
		mock.reply({ data: { status: 'stopped' } })
		mock.reply({ data: { status: 'stopped' } })
		const wait = waitForRunState(mock.client, ref, 'running', { timeoutMs: 0, initialDelayMs: 1 })
		await expect(wait).rejects.toBeInstanceOf(PveTimeoutError)
		await expect(
			waitForRunState(mock.client, ref, 'running', { timeoutMs: 0, initialDelayMs: 1 }),
		).rejects.toThrow(/waiting for qemu 9000 to be running; it is still stopped/)
	})
})

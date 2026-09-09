import { afterEach, describe, expect, test } from 'bun:test'
import { closeMockClients, mockClient } from '../core/test-support/api-mock.ts'
import { NodeReplicationApi } from './replication.ts'

afterEach(closeMockClients)

describe('NodeReplicationApi', () => {
	test('list normalizes the job rows', async () => {
		const mock = mockClient()
		mock.reply({
			data: [
				{
					id: '110-0',
					guest: 110,
					jobnum: 0,
					type: 'local',
					source: 'ms01-0160',
					target: 'ms02-0066',
					schedule: '*/15',
					disable: 0,
					last_try: 1710596322,
					last_sync: 1710596322,
					next_sync: 1710597222,
					duration: 3.5,
					fail_count: 2,
					error: 'command failed',
				},
			],
		})
		const [job] = await new NodeReplicationApi(mock.client, 'ms01-0160').list({ guest: 110 })
		expect(mock.last().path).toBe('/nodes/ms01-0160/replication?guest=110')
		expect(job).toMatchObject({
			id: '110-0',
			disable: false,
			lastTry: 1710596322,
			nextSync: 1710597222,
			failCount: 2,
			error: 'command failed',
			pid: undefined,
		})
		expect(job?.raw['fail_count']).toBe(2)
	})

	test('status, log, logPage and runNow address one job', async () => {
		const mock = mockClient()
		const replication = new NodeReplicationApi(mock.client, 'ms01-0160')

		mock.reply({ data: { id: '110-0', disable: 1 } })
		expect((await replication.status('110-0')).disable).toBe(true)
		expect(mock.last().path).toBe('/nodes/ms01-0160/replication/110-0/status')

		mock.reply({ data: [{ n: 1, t: 'start replication job' }] })
		expect(await replication.log('110-0', { limit: 10 })).toHaveLength(1)
		expect(mock.last().path).toBe('/nodes/ms01-0160/replication/110-0/log?limit=10')

		mock.reply({ data: [], attribs: { total: 3 } })
		expect(await replication.logPage('110-0')).toEqual({ lines: [], total: 3 })

		mock.reply({ data: 'UPID:ms01-0160:00000001:00000001:00000001:pvesr:110-0:root@pam:' })
		expect(await replication.runNow('110-0')).toStartWith('UPID:')
		expect([mock.last().method, mock.last().path]).toEqual([
			'POST',
			'/nodes/ms01-0160/replication/110-0/schedule_now',
		])
	})
})

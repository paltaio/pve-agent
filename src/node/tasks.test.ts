import { afterEach, describe, expect, test } from 'bun:test'
import { closeMockClients, mockClient } from '../core/test-support/api-mock.ts'
import { NodeTasksApi } from './tasks.ts'

afterEach(closeMockClients)

const REMOTE_UPID = 'UPID:ms02-0078:00001234:0000ABCD:65F0A1B2:vzdump:110:root@pam:'
const REMOTE_PATH =
	'/nodes/ms02-0078/tasks/UPID%3Ams02-0078%3A00001234%3A0000ABCD%3A65F0A1B2%3Avzdump%3A110%3Aroot%40pam%3A'

describe('NodeTasksApi', () => {
	test('list normalizes the rows and sends the filters', async () => {
		const mock = mockClient()
		mock.reply({
			data: [
				{
					upid: REMOTE_UPID,
					node: 'ms02-0078',
					type: 'vzdump',
					id: '110',
					user: 'root@pam',
					starttime: 1710596322,
					endtime: 1710596330,
					status: 'OK',
				},
			],
		})
		const [task] = await new NodeTasksApi(mock.client, 'ms01-0160').list({
			source: 'all',
			typefilter: 'vzdump',
			errors: false,
		})
		expect(mock.last().path).toBe('/nodes/ms01-0160/tasks?source=all&typefilter=vzdump&errors=0')
		expect(task).toMatchObject({ status: 'stopped', exitStatus: 'OK', outcome: 'ok' })
	})

	test('page returns the total the node reports beside data', async () => {
		const mock = mockClient()
		mock.reply({ data: [{ upid: REMOTE_UPID }], attribs: { total: 61 } })
		const page = await new NodeTasksApi(mock.client, 'ms01-0160').page({ limit: 1 })
		expect(mock.last().path).toBe('/nodes/ms01-0160/tasks?limit=1')
		expect(page.total).toBe(61)
		expect(page.tasks).toHaveLength(1)

		mock.reply({ data: [] })
		expect((await new NodeTasksApi(mock.client, 'ms01-0160').page()).total).toBeUndefined()
	})

	// The UPID names its own node, so a UPID handed out by another node's list
	// is read and stopped on that node rather than on this one.
	test('status, log and stop follow the node in the UPID', async () => {
		const mock = mockClient()
		const tasks = new NodeTasksApi(mock.client, 'ms01-0160')

		mock.reply({ data: { status: 'running' } })
		const status = await tasks.status(REMOTE_UPID)
		expect(mock.last().path).toBe(`${REMOTE_PATH}/status`)
		expect(status).toMatchObject({ node: 'ms02-0078', status: 'running', exitStatus: null })

		mock.reply({ data: [{ n: 1, t: 'starting' }] })
		expect(await tasks.log(REMOTE_UPID, { limit: 5 })).toEqual(['starting'])
		expect(mock.last().path).toBe(`${REMOTE_PATH}/log?start=0&limit=5`)

		await tasks.stop(REMOTE_UPID)
		expect([mock.last().method, mock.last().path]).toEqual(['DELETE', REMOTE_PATH])
	})
})

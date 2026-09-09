import { afterEach, expect, test } from 'bun:test'
import { closeMockClients, mockClient } from '../core/test-support/api-mock.ts'
import { getEnvelope } from './envelope.ts'

afterEach(closeMockClients)

test('getEnvelope returns data and the keys beside it', async () => {
	const mock = mockClient()
	mock.reply({ data: [{ upid: 'x' }], attribs: { total: 42 } })
	const result = await getEnvelope<{ upid: string }[]>(mock.client, '/nodes/ms01-0160/tasks', {
		limit: 1,
	})
	expect(mock.last().path).toBe('/nodes/ms01-0160/tasks?limit=1')
	expect(result.data).toEqual([{ upid: 'x' }])
	expect(result.attribs).toEqual({ total: 42 })
})

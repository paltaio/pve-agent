import { afterEach, expect, test } from 'bun:test'
import { closeMockClients, mockClient } from '../core/test-support/api-mock.ts'
import { envelopeTotal, getEnvelope } from './envelope.ts'

afterEach(closeMockClients)

test('getEnvelope returns data and the keys beside it', async () => {
	const mock = mockClient()
	mock.reply({ data: [{ upid: 'x' }], attribs: { total: 42 } })
	const result = await getEnvelope<{ upid: string }[]>(mock.client, '/nodes/ms01-0160/tasks', {
		limit: 1,
	})
	expect(mock.last().path).toBe('/nodes/ms01-0160/tasks?limit=1')
	expect(result.data).toEqual([{ upid: 'x' }])
	expect(envelopeTotal(result.attribs)).toBe(42)
})

test('envelopeTotal reads a numeric string and rejects anything else', () => {
	expect(envelopeTotal({ total: '17' })).toBe(17)
	expect(envelopeTotal({ total: '' })).toBeUndefined()
	expect(envelopeTotal({ total: 'many' })).toBeUndefined()
	expect(envelopeTotal({})).toBeUndefined()
})

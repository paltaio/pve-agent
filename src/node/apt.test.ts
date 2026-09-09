import { afterEach, describe, expect, test } from 'bun:test'
import { closeMockClients, formObject, mockClient } from '../core/test-support/api-mock.ts'
import { NodeAptApi } from './apt.ts'

afterEach(closeMockClients)

describe('NodeAptApi', () => {
	test('the reads hit their paths', async () => {
		const mock = mockClient()
		const apt = new NodeAptApi(mock.client, 'ms01-0160')
		for (const [call, path] of [
			[() => apt.listUpdates(), '/nodes/ms01-0160/apt/update'],
			[() => apt.versions(), '/nodes/ms01-0160/apt/versions'],
			[() => apt.repositories(), '/nodes/ms01-0160/apt/repositories'],
			[
				() => apt.changelog('pve-manager', { version: '9.2.11' }),
				'/nodes/ms01-0160/apt/changelog?name=pve-manager&version=9.2.11',
			],
		] as const) {
			mock.reply({ data: [] })
			await call()
			expect([mock.last().method, mock.last().path]).toEqual(['GET', path])
		}
	})

	test('update refreshes the index and returns a UPID', async () => {
		const mock = mockClient()
		mock.reply({ data: 'UPID:ms01-0160:00000001:00000001:00000001:aptupdate::root@pam:' })
		const upid = await new NodeAptApi(mock.client, 'ms01-0160').update({ notify: true })
		expect(upid).toStartWith('UPID:')
		expect([mock.last().method, mock.last().path]).toEqual(['POST', '/nodes/ms01-0160/apt/update'])
		expect(formObject(mock.last())).toEqual({ notify: '1' })
	})

	test('setRepository names the file and the index', async () => {
		const mock = mockClient()
		await new NodeAptApi(mock.client, 'ms01-0160').setRepository({
			path: '/etc/apt/sources.list.d/pve-enterprise.sources',
			index: 0,
			enabled: false,
		})
		expect([mock.last().method, mock.last().path]).toEqual([
			'POST',
			'/nodes/ms01-0160/apt/repositories',
		])
		expect(formObject(mock.last())).toEqual({
			path: '/etc/apt/sources.list.d/pve-enterprise.sources',
			index: '0',
			enabled: '0',
		})
	})
})

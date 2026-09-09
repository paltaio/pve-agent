import { afterEach, describe, expect, test } from 'bun:test'
import { closeMockClients, formObject, mockClient } from '../core/test-support/api-mock.ts'
import { NodeBackupApi } from './backup.ts'

afterEach(closeMockClients)

describe('NodeBackupApi', () => {
	test('run selects guests and returns a UPID', async () => {
		const mock = mockClient()
		mock.reply({ data: 'UPID:ms02-0078:00000001:00000001:00000001:vzdump::root@pam:' })
		const upid = await new NodeBackupApi(mock.client, 'ms02-0078').run({
			vmid: '110',
			storage: 'n5-backups',
			mode: 'snapshot',
			compress: 'zstd',
		})
		expect(upid).toStartWith('UPID:')
		expect([mock.last().method, mock.last().path]).toEqual(['POST', '/nodes/ms02-0078/vzdump'])
		expect(formObject(mock.last())).toEqual({
			vmid: '110',
			storage: 'n5-backups',
			mode: 'snapshot',
			compress: 'zstd',
		})
	})

	test('defaults and extractConfig are reads with their argument in the query', async () => {
		const mock = mockClient()
		const backup = new NodeBackupApi(mock.client, 'ms02-0078')

		mock.reply({ data: { compress: 'zstd' } })
		expect(await backup.defaults({ storage: 'n5-backups' })).toEqual({ compress: 'zstd' })
		expect(mock.last().path).toBe('/nodes/ms02-0078/vzdump/defaults?storage=n5-backups')

		mock.reply({ data: 'arch: amd64\n' })
		expect(await backup.extractConfig('n5-backups:backup/a.tar.zst')).toBe('arch: amd64\n')
		expect(mock.last().path).toBe(
			'/nodes/ms02-0078/vzdump/extractconfig?volume=n5-backups%3Abackup%2Fa.tar.zst',
		)
	})
})

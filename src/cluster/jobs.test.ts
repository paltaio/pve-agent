import { afterEach, expect, test } from 'bun:test'
import { closeMockClients, formObject, mockClient } from '../core/test-support/api-mock.ts'
import { ClusterJobsApi } from './jobs.ts'

afterEach(closeMockClients)

test('realm sync rows are normalized on list and on get', async () => {
	const mock = mockClient()
	const jobs = new ClusterJobsApi(mock.client)
	const row = {
		id: 'ldap-nightly',
		realm: 'ldap',
		enabled: 1,
		scope: 'both',
		'remove-vanished': 'acl;entry',
		'next-run': 1700000000,
		'last-run-state': 'OK',
	}
	mock.reply({ data: [row] })
	const [listed] = await jobs.listRealmSync()
	expect(mock.last().path).toBe('/cluster/jobs/realm-sync')
	expect(listed?.enabled).toBe(true)
	expect(listed?.scope).toBe('both')
	expect(listed?.removeVanished).toBe('acl;entry')
	expect(listed?.nextRun).toBe(1700000000)
	expect(listed?.lastRunState).toBe('OK')

	mock.reply({ data: row })
	const fetched = await jobs.getRealmSync('ldap-nightly')
	expect(mock.last().path).toBe('/cluster/jobs/realm-sync/ldap-nightly')
	expect(fetched.enabled).toBe(true)
	expect(fetched.raw).toEqual(row)
})

test('realm sync writes and the schedule parser', async () => {
	const mock = mockClient()
	const jobs = new ClusterJobsApi(mock.client)
	await jobs.createRealmSync('ldap-nightly', { schedule: 'daily', realm: 'ldap' })
	expect([mock.last().method, mock.last().path]).toEqual([
		'POST',
		'/cluster/jobs/realm-sync/ldap-nightly',
	])
	expect(formObject(mock.last())).toEqual({ schedule: 'daily', realm: 'ldap' })
	await jobs.updateRealmSync('ldap-nightly', { schedule: 'weekly', enabled: false })
	expect(mock.last().method).toBe('PUT')
	expect(formObject(mock.last())).toEqual({ schedule: 'weekly', enabled: '0' })
	await jobs.deleteRealmSync('ldap-nightly')
	expect(mock.last().method).toBe('DELETE')

	mock.reply({ data: [{ timestamp: 1700000000 }] })
	expect((await jobs.analyzeSchedule('03:00', { iterations: 1 }))[0]?.timestamp).toBe(1700000000)
	expect(mock.last().path).toBe('/cluster/jobs/schedule-analyze?schedule=03%3A00&iterations=1')
})

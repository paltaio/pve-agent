import { afterEach, expect, test } from 'bun:test'
import { closeMockClients, formObject, mockClient } from '../core/test-support/api-mock.ts'
import { ClusterNotificationsApi } from './notifications.ts'

afterEach(closeMockClients)

test('targets and matchers are normalized', async () => {
	const mock = mockClient()
	const notifications = new ClusterNotificationsApi(mock.client)
	mock.reply({
		data: [
			{ name: 'mail-to-root', type: 'sendmail', origin: 'builtin', disable: 0 },
			{ name: 'phone', type: 'gotify', origin: 'mystery' },
		],
	})
	const [builtin, phone] = await notifications.listTargets()
	expect(mock.last().path).toBe('/cluster/notifications/targets')
	expect(builtin?.origin).toBe('builtin')
	expect(builtin?.disable).toBe(false)
	expect(phone?.origin).toBeUndefined()

	mock.reply({
		data: {
			name: 'errors',
			'match-severity': ['error', 'warning'],
			target: ['phone'],
			mode: 'any',
			'invert-match': 1,
		},
	})
	const matcher = await notifications.getMatcher('errors')
	expect(mock.last().path).toBe('/cluster/notifications/matchers/errors')
	expect(matcher.matchSeverity).toEqual(['error', 'warning'])
	expect(matcher.matchField).toEqual([])
	expect(matcher.target).toEqual(['phone'])
	expect(matcher.mode).toBe('any')
	expect(matcher.invertMatch).toBe(true)
})

test('endpoint kinds, target test and matcher writes', async () => {
	const mock = mockClient()
	const notifications = new ClusterNotificationsApi(mock.client)
	await notifications.gotify.create({ name: 'phone', server: 'https://g', token: 't' })
	expect(mock.last().path).toBe('/cluster/notifications/endpoints/gotify')
	expect(formObject(mock.last())).toEqual({ name: 'phone', server: 'https://g', token: 't' })
	await notifications.smtp.update('relay', { disable: true })
	expect([mock.last().method, mock.last().path]).toEqual([
		'PUT',
		'/cluster/notifications/endpoints/smtp/relay',
	])
	expect(formObject(mock.last())).toEqual({ disable: '1' })
	await notifications.webhook.delete('hook')
	expect([mock.last().method, mock.last().path]).toEqual([
		'DELETE',
		'/cluster/notifications/endpoints/webhook/hook',
	])
	mock.reply({ data: [{ name: 'mail', type: 'sendmail' }] })
	expect((await notifications.sendmail.list())[0]?.name).toBe('mail')
	expect(mock.last().path).toBe('/cluster/notifications/endpoints/sendmail')
	mock.reply({ data: { name: 'mail', type: 'sendmail', disable: 1 } })
	expect((await notifications.sendmail.get('mail')).disable).toBe(true)

	await notifications.testTarget('mail-to-root')
	expect(mock.last().path).toBe('/cluster/notifications/targets/mail-to-root/test')

	await notifications.createMatcher({ name: 'errors', 'match-severity': ['error'] })
	expect(mock.last().body).toBe('name=errors&match-severity=error')
	await notifications.updateMatcher('errors', { mode: 'any' })
	expect(mock.last().method).toBe('PUT')
	expect(formObject(mock.last())).toEqual({ mode: 'any' })
	await notifications.deleteMatcher('errors')
	expect([mock.last().method, mock.last().path]).toEqual([
		'DELETE',
		'/cluster/notifications/matchers/errors',
	])
	mock.reply({ data: [] })
	await notifications.matcherFields()
	expect(mock.last().path).toBe('/cluster/notifications/matcher-fields')
})

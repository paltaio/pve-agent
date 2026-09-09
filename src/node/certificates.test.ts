import { afterEach, describe, expect, test } from 'bun:test'
import { closeMockClients, formObject, mockClient } from '../core/test-support/api-mock.ts'
import { NodeCertificatesApi } from './certificates.ts'

afterEach(closeMockClients)

describe('NodeCertificatesApi', () => {
	test('info lists the served certificates', async () => {
		const mock = mockClient()
		mock.reply({ data: [{ filename: 'pveproxy-ssl.pem', notafter: 1 }] })
		const [cert] = await new NodeCertificatesApi(mock.client, 'ms01-0160').info()
		expect(mock.last().path).toBe('/nodes/ms01-0160/certificates/info')
		expect(cert?.filename).toBe('pveproxy-ssl.pem')
	})

	test('custom certificate writes', async () => {
		const mock = mockClient()
		const certs = new NodeCertificatesApi(mock.client, 'ms01-0160')
		mock.reply({ data: { filename: 'pveproxy-ssl.pem' } })
		await certs.setCustom({ certificates: '-----BEGIN CERTIFICATE-----', restart: true })
		expect([mock.last().method, mock.last().path]).toEqual([
			'POST',
			'/nodes/ms01-0160/certificates/custom',
		])
		expect(formObject(mock.last())).toEqual({
			certificates: '-----BEGIN CERTIFICATE-----',
			restart: '1',
		})
		await certs.deleteCustom({ restart: true })
		expect([mock.last().method, mock.last().path]).toEqual([
			'DELETE',
			'/nodes/ms01-0160/certificates/custom?restart=1',
		])
		expect(mock.last().body).toBe('')
	})

	test('acme order, renew and revoke share one path', async () => {
		const mock = mockClient()
		const certs = new NodeCertificatesApi(mock.client, 'ms01-0160')
		for (const [call, method, body] of [
			[() => certs.orderAcme({ force: true }), 'POST', 'force=1'],
			[() => certs.renewAcme(), 'PUT', ''],
			[() => certs.revokeAcme(), 'DELETE', ''],
		] as const) {
			mock.reply({ data: 'UPID:ms01-0160:00000001:00000001:00000001:acme::root@pam:' })
			expect(await call()).toStartWith('UPID:')
			expect([mock.last().method, mock.last().path]).toEqual([
				method,
				'/nodes/ms01-0160/certificates/acme/certificate',
			])
			expect(mock.last().body).toBe(body)
		}
	})
})

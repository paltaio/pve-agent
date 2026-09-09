import { afterEach, describe, expect, test } from 'bun:test'
import { closeMockClients, formObject, mockClient } from '../core/test-support/api-mock.ts'
import {
	consoleAuthHeaders,
	consoleTier,
	consoleWebSocketUrl,
	requestTermProxy,
	requestVncProxy,
} from './proxy.ts'

afterEach(closeMockClients)

describe('requestVncProxy', () => {
	test('asks QEMU for a websocket and a one-time password on the ticket', async () => {
		const mock = mockClient()
		mock.reply({
			data: {
				port: '5900',
				ticket: 'PVEVNC:TICKET',
				password: 'aBcD1234',
				user: 'root@pam',
				upid: 'UPID:ms01:x',
			},
		})

		const ticket = await requestVncProxy(mock.client, { node: 'ms01-0160', vmid: 9030 })

		const call = mock.calls()[0]
		expect(call?.method).toBe('POST')
		expect(call?.path).toBe('/nodes/ms01-0160/qemu/9030/vncproxy')
		expect(call && formObject(call)).toEqual({ websocket: '1', 'generate-password': '1' })
		expect(call?.headers['cookie']).toBe('PVEAuthCookie=PVE%3Aroot%40pam%3ATICKET')
		expect(call?.headers['authorization']).toBeUndefined()
		expect(ticket).toEqual({
			port: '5900',
			ticket: 'PVEVNC:TICKET',
			user: 'root@pam',
			password: 'aBcD1234',
			upid: 'UPID:ms01:x',
		})
	})

	test('uses the token when there is no ticket credential', async () => {
		const mock = mockClient({ ticket: false })
		mock.reply({ data: { port: 5900, ticket: 'T', user: 'agents@pve!ci', password: 'pw' } })

		const ticket = await requestVncProxy(mock.client, { node: 'ms01', vmid: 100, type: 'qemu' })

		expect(mock.last().headers['authorization']).toBe('PVEAPIToken=agents@pve!ci=secret')
		expect(mock.last().headers['cookie']).toBeUndefined()
		expect(ticket.port).toBe('5900')
	})

	test('leaves generate-password off for LXC, which has no such parameter', async () => {
		const mock = mockClient()
		mock.reply({ data: { port: '5901', ticket: 'PVEVNC:T', user: 'root@pam' } })

		const ticket = await requestVncProxy(mock.client, { node: 'ms02-0078', vmid: 110, type: 'lxc' })

		expect(mock.last().path).toBe('/nodes/ms02-0078/lxc/110/vncproxy')
		expect(formObject(mock.last())).toEqual({ websocket: '1' })
		expect(ticket.password).toBeUndefined()
	})

	test('names the missing field when the answer is short', async () => {
		const mock = mockClient()
		mock.reply({ data: { ticket: 'PVEVNC:T' } })
		await expect(requestVncProxy(mock.client, { node: 'ms01', vmid: 1 })).rejects.toThrow(
			/vncproxy answered without a 'port' field/,
		)
	})
})

describe('consoleWebSocketUrl', () => {
	test('escapes the ticket and keeps the guest type', () => {
		const url = consoleWebSocketUrl(
			'https://192.0.2.21:8006',
			{ node: 'ms02-0078', vmid: 110, type: 'lxc' },
			'5900',
			'PVEVNC:68B/AA==::abc+def/ghi',
		)
		expect(url).toBe(
			'wss://192.0.2.21:8006/api2/json/nodes/ms02-0078/lxc/110/vncwebsocket' +
				'?port=5900&vncticket=PVEVNC%3A68B%2FAA%3D%3D%3A%3Aabc%2Bdef%2Fghi',
		)
	})

	test('takes a path in place of a guest, for a node shell', async () => {
		const mock = mockClient()
		mock.reply({ data: { port: 5901, ticket: 'T', user: 'root@pam' } })
		const ticket = await requestTermProxy(mock.client, '/nodes/pve1')
		expect(mock.last().path).toBe('/nodes/pve1/termproxy')
		expect(ticket.port).toBe('5901')
		expect(consoleWebSocketUrl('https://pve:8006', '/nodes/pve1', '5901', 'T')).toBe(
			'wss://pve:8006/api2/json/nodes/pve1/vncwebsocket?port=5901&vncticket=T',
		)
	})
})

describe('console credentials', () => {
	test('prefer the ticket and URL-encode it in the cookie', async () => {
		const mock = mockClient()
		expect(consoleTier(mock.client.auth)).toBe('ticket')
		expect(await consoleAuthHeaders(mock.client.auth)).toEqual({
			Cookie: 'PVEAuthCookie=PVE%3Aroot%40pam%3ATICKET',
		})
	})

	test('fall back to the token header', async () => {
		const mock = mockClient({ ticket: false })
		expect(consoleTier(mock.client.auth)).toBe('token')
		expect(await consoleAuthHeaders(mock.client.auth)).toEqual({
			Authorization: 'PVEAPIToken=agents@pve!ci=secret',
		})
	})
})

describe('requestTermProxy', () => {
	test('names the serial port of a VM and reads the ticket back', async () => {
		const mock = mockClient()
		mock.reply({
			data: { port: 5901, ticket: 'PVEVNC:TICKET', user: 'root@pam', upid: 'UPID:ms02:x' },
		})

		const ticket = await requestTermProxy(
			mock.client,
			{ node: 'ms02-0078', vmid: 101 },
			{ serial: 'serial0' },
		)

		const call = mock.calls()[0]
		expect(call?.method).toBe('POST')
		expect(call?.path).toBe('/nodes/ms02-0078/qemu/101/termproxy')
		expect(call && formObject(call)).toEqual({ serial: 'serial0' })
		expect(call?.headers['cookie']).toBe('PVEAuthCookie=PVE%3Aroot%40pam%3ATICKET')
		expect(ticket).toEqual({
			port: '5901',
			ticket: 'PVEVNC:TICKET',
			user: 'root@pam',
			upid: 'UPID:ms02:x',
		})
	})

	test('a container gets no parameters and a token goes in the header', async () => {
		const mock = mockClient({ ticket: false })
		mock.reply({ data: { port: '5902', ticket: 'PVEVNC:T', user: 'api@pve!tok' } })

		const ticket = await requestTermProxy(mock.client, {
			node: 'ms02-0078',
			vmid: 110,
			type: 'lxc',
		})

		const call = mock.calls()[0]
		expect(call?.path).toBe('/nodes/ms02-0078/lxc/110/termproxy')
		expect(call?.body).toBe('')
		expect(call?.headers['authorization']).toMatch(/^PVEAPIToken=/)
		expect(ticket).toEqual({ port: '5902', ticket: 'PVEVNC:T', user: 'api@pve!tok' })
	})

	test('an answer without a ticket is a console error', async () => {
		const mock = mockClient()
		mock.reply({ data: { port: '5900', user: 'root@pam' } })
		await expect(requestTermProxy(mock.client, { node: 'ms02-0078', vmid: 101 })).rejects.toThrow(
			/termproxy answered without a 'ticket' field/,
		)
	})
})

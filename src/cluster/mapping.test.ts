import { afterEach, expect, test } from 'bun:test'
import { closeMockClients, formObject, mockClient } from '../core/test-support/api-mock.ts'
import { ClusterMappingApi } from './mapping.ts'

afterEach(closeMockClients)

test('each kind hangs off its own path', async () => {
	const mock = mockClient()
	const mapping = new ClusterMappingApi(mock.client)

	mock.reply({ data: [{ id: 'gpu0', map: ['node=ms02-0078,path=0000:01:00.0'] }] })
	expect((await mapping.pci.list({ 'check-node': 'ms02-0078' }))[0]?.id).toBe('gpu0')
	expect(mock.last().path).toBe('/cluster/mapping/pci?check-node=ms02-0078')

	mock.reply({ data: { id: 'gpu0' } })
	await mapping.pci.get('gpu0')
	expect(mock.last().path).toBe('/cluster/mapping/pci/gpu0')

	await mapping.pci.create({ id: 'gpu0', map: ['node=ms02-0078,path=0000:01:00.0,id=10de:2482'] })
	expect([mock.last().method, mock.last().path]).toEqual(['POST', '/cluster/mapping/pci'])
	expect(formObject(mock.last())).toEqual({
		id: 'gpu0',
		map: 'node=ms02-0078,path=0000:01:00.0,id=10de:2482',
	})

	await mapping.usb.update('yubikey', { map: ['node=ms01-0160,path=1-2'] })
	expect([mock.last().method, mock.last().path]).toEqual(['PUT', '/cluster/mapping/usb/yubikey'])
	expect(formObject(mock.last())).toEqual({ map: 'node=ms01-0160,path=1-2' })

	await mapping.dir.delete('media')
	expect([mock.last().method, mock.last().path]).toEqual(['DELETE', '/cluster/mapping/dir/media'])
})

test('a multi-node map repeats the key', async () => {
	const mock = mockClient()
	await new ClusterMappingApi(mock.client).pci.create({
		id: 'gpu0',
		map: ['node=ms01-0160,path=0000:01:00.0', 'node=ms02-0078,path=0000:02:00.0'],
	})
	expect(mock.last().body).toBe(
		'id=gpu0&map=node%3Dms01-0160%2Cpath%3D0000%3A01%3A00.0&map=node%3Dms02-0078%2Cpath%3D0000%3A02%3A00.0',
	)
})

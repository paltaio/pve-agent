import { afterEach, describe, expect, test } from 'bun:test'
import { PveTierError } from '../core/errors.ts'
import type { RequestTrace } from '../core/client.ts'
import {
	closeMockClients,
	formObject,
	mockClient,
	multipart,
} from '../core/test-support/api-mock.ts'
import { NodeStorageApi } from './storage.ts'

afterEach(closeMockClients)

const UPID = 'UPID:ms01-0160:00000001:00000001:00000001:imgcopy::root@pam:'

describe('NodeStorageApi reads', () => {
	test('list turns availability flags into booleans and keeps raw', async () => {
		const mock = mockClient()
		mock.reply({
			data: [
				{
					storage: 'ms01-vms',
					type: 'zfspool',
					content: 'images,rootdir',
					active: 0,
					enabled: 0,
					shared: 0,
					total: 0,
					used_fraction: 0.5,
				},
			],
		})
		const [row] = await new NodeStorageApi(mock.client, 'ms02-0066').list({ enabled: true })
		expect(mock.last().path).toBe('/nodes/ms02-0066/storage?enabled=1')
		expect(row).toMatchObject({
			storage: 'ms01-vms',
			active: false,
			enabled: false,
			shared: false,
			usedFraction: 0.5,
		})
		expect(row?.raw['active']).toBe(0)
	})

	test('status folds missing sizes to zero', async () => {
		const mock = mockClient()
		mock.reply({ data: { type: 'dir', content: 'iso', active: 1, enabled: 1 } })
		const status = await new NodeStorageApi(mock.client, 'ms01-0160').status('local')
		expect(mock.last().path).toBe('/nodes/ms01-0160/storage/local/status')
		expect(status).toMatchObject({ type: 'dir', active: true, enabled: true, total: 0 })
	})

	test('content normalizes volumes and their verification blob', async () => {
		const mock = mockClient()
		mock.reply({
			data: [
				{
					volid: 'pbs:backup/vm/110/2026-01-01T00:00:00Z',
					content: 'backup',
					size: '1024',
					vmid: 110,
					protected: 1,
					verification: { state: 'ok', upid: 'x' },
				},
				{ volid: 'local:iso/x.iso', content: 'iso', size: 1, verification: 'no' },
			],
		})
		const [backup, iso] = await new NodeStorageApi(mock.client, 'ms01-0160').content('pbs', {
			content: 'backup',
			vmid: 110,
		})
		expect(mock.last().path).toBe('/nodes/ms01-0160/storage/pbs/content?content=backup&vmid=110')
		expect(backup).toMatchObject({
			size: 1024,
			vmid: 110,
			protected: true,
			verification: { state: 'ok' },
		})
		expect(iso?.verification).toBeUndefined()
	})

	test('a volume id is encoded into the path, slashes included', async () => {
		const mock = mockClient()
		mock.reply({ data: { path: '/var/lib/vz/template/iso/x.iso', size: 1 } })
		const volume = await new NodeStorageApi(mock.client, 'ms01-0160').volume(
			'local',
			'local:iso/x.iso',
		)
		expect(mock.last().path).toBe('/nodes/ms01-0160/storage/local/content/local%3Aiso%2Fx.iso')
		expect(volume.path).toBe('/var/lib/vz/template/iso/x.iso')
	})

	test('prunePreview normalizes candidates and fileRestoreList reads leaf as a boolean', async () => {
		const mock = mockClient()
		const storage = new NodeStorageApi(mock.client, 'ms02-0078')

		mock.reply({ data: [{ volid: 'b:backup/a.tar.zst', ctime: 1, type: 'lxc', mark: 'remove' }] })
		const [candidate] = await storage.prunePreview('b', { 'prune-backups': 'keep-last=1' })
		expect(mock.last().path).toBe(
			'/nodes/ms02-0078/storage/b/prunebackups?prune-backups=keep-last%3D1',
		)
		expect(candidate).toMatchObject({ mark: 'remove', vmid: undefined })

		mock.reply({ data: [{ filepath: 'L2V0Yw==', text: 'etc', type: 'd', leaf: 0 }] })
		const [entry] = await storage.fileRestoreList('b', 'b:backup/a.tar.zst', '/')
		expect(mock.last().path).toBe(
			'/nodes/ms02-0078/storage/b/file-restore/list?volume=b%3Abackup%2Fa.tar.zst&filepath=%2F',
		)
		expect(entry?.leaf).toBe(false)
	})

	test('the file-restore download is signed, not fetched', async () => {
		const mock = mockClient()
		const signed = await new NodeStorageApi(mock.client, 'ms02-0078').fileRestoreDownload(
			'n5-backups',
			'n5-backups:backup/vzdump-lxc-110.tar.zst',
			'/etc',
			{ tar: true },
		)
		expect(signed.url).toEndWith(
			'/api2/json/nodes/ms02-0078/storage/n5-backups/file-restore/download?volume=n5-backups%3Abackup%2Fvzdump-lxc-110.tar.zst&filepath=%2Fetc&tar=1',
		)
		expect(signed.headers['Authorization']).toStartWith('PVEAPIToken=')
		expect(mock.calls()).toHaveLength(0)
	})

	test('importMetadata passes the volume in the query string', async () => {
		const mock = mockClient()
		mock.reply({ data: { 'create-args': {} } })
		await new NodeStorageApi(mock.client, 'ms02-0078').importMetadata(
			'local',
			'local:import/vm.ova',
		)
		expect(mock.last().path).toBe(
			'/nodes/ms02-0078/storage/local/import-metadata?volume=local%3Aimport%2Fvm.ova',
		)
	})
})

describe('NodeStorageApi writes', () => {
	test('allocate, updateVolume and downloadUrl send form bodies', async () => {
		const mock = mockClient()
		const storage = new NodeStorageApi(mock.client, 'ms02-0078')

		mock.reply({ data: 'tank-vms:vm-120-disk-0' })
		expect(
			await storage.allocate('tank-vms', { filename: 'vm-120-disk-0', size: '32G', vmid: 120 }),
		).toBe('tank-vms:vm-120-disk-0')
		expect(mock.last().path).toBe('/nodes/ms02-0078/storage/tank-vms/content')
		expect(formObject(mock.last())).toEqual({
			filename: 'vm-120-disk-0',
			size: '32G',
			vmid: '120',
		})

		await storage.updateVolume('n5-backups', 'n5-backups:backup/a.tar.zst', { protected: true })
		expect([mock.last().method, mock.last().path]).toEqual([
			'PUT',
			'/nodes/ms02-0078/storage/n5-backups/content/n5-backups%3Abackup%2Fa.tar.zst',
		])
		expect(formObject(mock.last())).toEqual({ protected: '1' })

		mock.reply({ data: UPID })
		await storage.downloadUrl('local', {
			content: 'iso',
			filename: 'debian.iso',
			url: 'https://example.test/debian.iso',
			'checksum-algorithm': 'sha256',
			checksum: 'abc',
		})
		expect(mock.last().path).toBe('/nodes/ms02-0078/storage/local/download-url')
		expect(formObject(mock.last())).toEqual({
			content: 'iso',
			filename: 'debian.iso',
			url: 'https://example.test/debian.iso',
			'checksum-algorithm': 'sha256',
			checksum: 'abc',
		})
	})

	test('deleteVolume and pruneBackups put their options in the query string', async () => {
		const mock = mockClient()
		const storage = new NodeStorageApi(mock.client, 'ms01-0160')

		mock.reply({ data: UPID })
		await storage.deleteVolume('local', 'local:iso/x.iso', { delay: 10 })
		expect(mock.last().method).toBe('DELETE')
		expect(mock.last().path).toBe(
			'/nodes/ms01-0160/storage/local/content/local%3Aiso%2Fx.iso?delay=10',
		)
		expect(mock.last().body).toBe('')

		mock.reply({ data: UPID })
		await storage.pruneBackups('n5-backups', { 'prune-backups': 'keep-daily=3', vmid: 110 })
		expect(mock.last().path).toBe(
			'/nodes/ms01-0160/storage/n5-backups/prunebackups?prune-backups=keep-daily%3D3&vmid=110',
		)
	})

	test('copyVolume needs a root@pam ticket', async () => {
		const mock = mockClient({ ticket: false })
		await expect(
			new NodeStorageApi(mock.client, 'ms02-0078').copyVolume('tank-vms', 'tank-vms:x', {
				target: 'tank-vms:y',
			}),
		).rejects.toBeInstanceOf(PveTierError)
		expect(mock.calls()).toHaveLength(0)
	})
})

describe('NodeStorageApi.upload', () => {
	test('the multipart fields go over in the order the server parses them', async () => {
		const mock = mockClient()
		mock.reply({ data: UPID })
		const upid = await new NodeStorageApi(mock.client, 'ms01-0160').upload(
			'local',
			new Blob([new Uint8Array([1, 2, 3])]),
			{ content: 'iso', filename: 'debian.iso', checksum: 'abc', 'checksum-algorithm': 'sha256' },
		)
		expect(upid).toBe(UPID)
		expect([mock.last().method, mock.last().path]).toEqual([
			'POST',
			'/nodes/ms01-0160/storage/local/upload',
		])

		const form = multipart(mock.last())
		expect(Object.keys(form)).toEqual(['content', 'checksum-algorithm', 'checksum', 'filename'])
		expect(form['content']?.text).toBe('iso')
		expect(form['checksum-algorithm']?.text).toBe('sha256')
		expect(form['checksum']?.text).toBe('abc')
		expect(form['filename']?.filename).toBe('debian.iso')
		expect(form['filename']?.text).toBe('')
	})

	test('optional checksum fields are left out', async () => {
		const mock = mockClient()
		mock.reply({ data: UPID })
		await new NodeStorageApi(mock.client, 'ms01-0160').upload('local', new Blob(['x']), {
			content: 'vztmpl',
			filename: 'alpine.tar.xz',
		})
		expect(Object.keys(multipart(mock.last()))).toEqual(['content', 'filename'])
	})

	test('the upload runs through the client, so the tier decision and trace apply', async () => {
		const traces: string[] = []
		const mock = mockClient({
			onRequest: (trace: RequestTrace) =>
				traces.push(`${trace.decision.tier} ${trace.method} ${trace.endpointPath}`),
		})
		mock.reply({ data: UPID })
		await new NodeStorageApi(mock.client, 'ms01-0160').upload('local', new Blob(['x']), {
			content: 'iso',
			filename: 'x.iso',
		})
		expect(traces).toEqual(['token POST /nodes/{node}/storage/{storage}/upload'])
		expect(mock.last().headers['content-type']).toStartWith('multipart/form-data; boundary=')
		expect(mock.last().headers['authorization']).toStartWith('PVEAPIToken=')
	})
})

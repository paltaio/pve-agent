import { afterEach, describe, expect, test } from 'bun:test'
import { closeMockClients, mockClient } from '../core/test-support/api-mock.ts'
import { NodeHardwareApi } from './hardware.ts'

afterEach(closeMockClients)

describe('NodeHardwareApi', () => {
	test('listPci normalizes the rows', async () => {
		const mock = mockClient()
		mock.reply({
			data: [
				{
					id: '0000:00:02.0',
					class: '0x030000',
					vendor: '0x8086',
					device: '0x46a6',
					iommugroup: 0,
					vendor_name: 'Intel Corporation',
					device_name: 'Alder Lake-P GT2',
					subsystem_vendor: '0x8086',
					mdev: 1,
				},
				{ id: '0000:01:00.0', class: '0x010802', vendor: '0x144d', device: '0xa80a' },
			],
		})
		const [igpu, nvme] = await new NodeHardwareApi(mock.client, 'ms01-0160').listPci({
			verbose: true,
		})
		expect(mock.last().path).toBe('/nodes/ms01-0160/hardware/pci?verbose=1')
		expect(igpu).toMatchObject({
			id: '0000:00:02.0',
			iommugroup: 0,
			vendorName: 'Intel Corporation',
			deviceName: 'Alder Lake-P GT2',
			subsystemVendor: '0x8086',
			mdev: true,
		})
		expect(igpu?.raw['mdev']).toBe(1)
		expect(nvme).toMatchObject({ iommugroup: -1, mdev: undefined, vendorName: undefined })
	})

	test('mdev types and usb devices hit their paths', async () => {
		const mock = mockClient()
		const hardware = new NodeHardwareApi(mock.client, 'ms01-0160')

		mock.reply({ data: [] })
		await hardware.listMdevTypes('0000:00:02.0')
		expect(mock.last().path).toBe('/nodes/ms01-0160/hardware/pci/0000%3A00%3A02.0/mdev')

		mock.reply({ data: [{ busnum: 1, devnum: 2, class: 9, vendid: '1d6b', prodid: '0002' }] })
		const [usb] = await hardware.listUsb()
		expect(mock.last().path).toBe('/nodes/ms01-0160/hardware/usb')
		expect(usb?.vendid).toBe('1d6b')
	})
})

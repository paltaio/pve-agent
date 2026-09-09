/**
 * PCI and USB devices the node can see.
 *
 * These are raw addresses. Passing a device to a guest by raw address needs a
 * root@pam ticket; a cluster mapping under `/cluster/mapping` referenced by
 * name does not, and survives migration.
 */

import type { PveClient } from '../core/client.ts'
import { toOptionalBoolean, toOptionalNumber, toOptionalString } from '../core/values.ts'
import type { NodesHardwarePciGetByNodeParams } from '../generated/types.ts'

export interface PciDevice {
	id: string
	class: string
	vendor: string
	device: string
	/** -1 when the device is in no IOMMU group. */
	iommugroup: number
	subsystemVendor: string | undefined
	subsystemDevice: string | undefined
	vendorName: string | undefined
	deviceName: string | undefined
	subsystemVendorName: string | undefined
	subsystemDeviceName: string | undefined
	/** True when the device can be split into mediated devices. */
	mdev: boolean | undefined
	raw: Readonly<Record<string, unknown>>
}

function normalizePci(raw: Record<string, unknown>): PciDevice {
	return {
		id: String(raw['id'] ?? ''),
		class: String(raw['class'] ?? ''),
		vendor: String(raw['vendor'] ?? ''),
		device: String(raw['device'] ?? ''),
		iommugroup: toOptionalNumber(raw['iommugroup']) ?? -1,
		subsystemVendor: toOptionalString(raw['subsystem_vendor']),
		subsystemDevice: toOptionalString(raw['subsystem_device']),
		vendorName: toOptionalString(raw['vendor_name']),
		deviceName: toOptionalString(raw['device_name']),
		subsystemVendorName: toOptionalString(raw['subsystem_vendor_name']),
		subsystemDeviceName: toOptionalString(raw['subsystem_device_name']),
		mdev: toOptionalBoolean(raw['mdev']),
		raw,
	}
}

export interface UsbDevice extends Record<string, unknown> {
	busnum: number
	devnum: number
	class: number
	vendid: string
	prodid: string
	speed: string
	port: number
	level: number
	manufacturer?: string
	product?: string
	serial?: string
	usbpath?: string
}

export interface MdevType extends Record<string, unknown> {
	type: string
	available: number
	description: string
	name?: string
}

export class NodeHardwareApi {
	private readonly client: PveClient
	private readonly base: string

	constructor(client: PveClient, node: string) {
		this.client = client
		this.base = `/nodes/${encodeURIComponent(node)}/hardware`
	}

	/**
	 * PCI devices with their IOMMU group. A device can only be passed through
	 * together with every other member of its group. `pci-class-blacklist`
	 * defaults to hiding bridges and memory controllers.
	 */
	async listPci(options?: NodesHardwarePciGetByNodeParams): Promise<PciDevice[]> {
		const rows = await this.client.get<Record<string, unknown>[]>(`${this.base}/pci`, options)
		return rows.map(normalizePci)
	}

	/**
	 * Mediated device types one PCI device offers, with how many of each are
	 * still free. Empty on a device without SR-IOV or vGPU support.
	 */
	async listMdevTypes(pciIdOrMapping: string): Promise<MdevType[]> {
		return this.client.get<MdevType[]>(
			`${this.base}/pci/${encodeURIComponent(pciIdOrMapping)}/mdev`,
		)
	}

	/** USB devices, by bus and device number. */
	async listUsb(): Promise<UsbDevice[]> {
		return this.client.get<UsbDevice[]>(`${this.base}/usb`)
	}
}

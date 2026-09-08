/**
 * Which parameters force a root@pam login ticket.
 *
 * ROOT_ONLY_ENDPOINTS covers whole endpoints. This module covers the
 * parameters a reachable endpoint refuses from anyone but root@pam. Some say
 * so in their own schema description, and the generator collects those into
 * DOCUMENTED_ROOT_ONLY_PARAMS. The rest are checked in handler code with
 * nothing in the schema to show for it, and several depend on the value rather
 * than the name, so they live in the table below. A rule in the table decides
 * for the parameter it names; the documented list fills in the parameters no
 * rule covers.
 */

import { DOCUMENTED_ROOT_ONLY_PARAMS } from '../generated/endpoints.ts'
import { splitIndexedKey, splitPropertyParts } from './props.ts'

export interface RootOnlyParamRule {
	/** Schema parameter name; an indexed family is written as `mp[n]`. */
	param: string
	/** Registry path templates the rule covers. */
	path: RegExp
	reason: string
	/** When set, only values this returns true for need the ticket. */
	applies?: (value: unknown) => boolean
}

export interface RootOnlyParamHit {
	param: string
	reason: string
}

const QEMU_GUEST = /^\/nodes\/\{node\}\/qemu\/\{vmid\}(\/|$)/
const QEMU_START = /^\/nodes\/\{node\}\/qemu\/\{vmid\}\/status\/start$/
const QEMU_STOP = /^\/nodes\/\{node\}\/qemu\/\{vmid\}\/status\/stop$/
const QEMU_CREATE_OR_CONFIG = /^\/nodes\/\{node\}\/qemu(\/\{vmid\}\/config)?$/
const LXC_CREATE_OR_CONFIG = /^\/nodes\/\{node\}\/lxc(\/\{vmid\}\/config)?$/
const GUEST_CREATE_OR_CONFIG = /^\/nodes\/\{node\}\/(qemu|lxc)(\/\{vmid\}\/config)?$/
const GUEST = /^\/nodes\/\{node\}\/(qemu|lxc)\/\{vmid\}(\/|$)/
const NODE_SHELL = /^\/nodes\/\{node\}\/(termproxy|vncshell|spiceshell)$/

function text(value: unknown): string {
	return typeof value === 'string' ? value : String(value ?? '')
}

function subKey(value: unknown, key: string): string | undefined {
	return splitPropertyParts(text(value)).entries.find(([name]) => name === key)?.[1]
}

/** PVE classifies a mount point by its volume: /dev/... is a device, / is a bind. */
function isNonVolumeMountPoint(value: unknown): boolean {
	const parts = splitPropertyParts(text(value))
	const volume = parts.bare[0] ?? subKey(value, 'volume') ?? ''
	return volume.startsWith('/')
}

/** Anything past `nesting` needs root; `nesting=1` alone does not. */
function usesPrivilegedLxcFeature(value: unknown): boolean {
	const parts = splitPropertyParts(text(value))
	return parts.entries.some(([key]) => key !== 'nesting') || parts.bare.length > 0
}

/** `host` is the default key of the usb and hostpci formats, so a bare part is a host device. */
function hostDevice(value: unknown): string | undefined {
	const parts = splitPropertyParts(text(value))
	return parts.bare[0] ?? subKey(value, 'host')
}

export const ROOT_ONLY_PARAM_RULES: readonly RootOnlyParamRule[] = [
	{
		param: 'skiplock',
		path: GUEST,
		reason: 'skiplock is honoured only for root@pam',
	},
	{
		param: 'hookscript',
		path: GUEST_CREATE_OR_CONFIG,
		reason: 'a hookscript runs arbitrary code on the node',
	},
	{
		param: 'args',
		path: QEMU_CREATE_OR_CONFIG,
		reason: 'args is passed straight to kvm',
	},
	{
		param: 'lock',
		path: QEMU_CREATE_OR_CONFIG,
		reason: 'the config lock can only be set by root@pam',
	},
	{
		param: 'serial[n]',
		path: QEMU_CREATE_OR_CONFIG,
		reason: 'a serial port backed by a real host device needs root@pam',
		applies: (value) => text(value) !== 'socket',
	},
	{
		param: 'usb[n]',
		path: QEMU_CREATE_OR_CONFIG,
		reason: 'raw USB passthrough needs root@pam; use a mapping= entry or host=spice instead',
		applies: (value) => {
			const host = hostDevice(value)
			return host !== undefined && host.toLowerCase() !== 'spice'
		},
	},
	{
		param: 'hostpci[n]',
		path: QEMU_CREATE_OR_CONFIG,
		reason:
			'raw PCI passthrough and romfile need root@pam; use a mapping= entry without romfile instead',
		applies: (value) => hostDevice(value) !== undefined || subKey(value, 'romfile') !== undefined,
	},
	{
		param: 'stateuri',
		path: QEMU_START,
		reason: 'restoring VM state from a URI needs root@pam',
	},
	{
		param: 'migratedfrom',
		path: /^\/nodes\/\{node\}\/qemu\/\{vmid\}\/status\/(start|stop)$/,
		reason: 'migratedfrom is set by the migration worker, which runs as root@pam',
	},
	{
		param: 'targetstorage',
		path: QEMU_START,
		reason: 'a storage map on start belongs to the migration worker, which runs as root@pam',
	},
	{
		param: 'force-cpu',
		path: QEMU_START,
		reason: 'overriding the CPU model on start needs root@pam',
	},
	{
		param: 'with-conntrack-state',
		path: QEMU_START,
		reason: 'restoring conntrack state needs root@pam',
	},
	{
		param: 'nets-host-mtu',
		path: QEMU_START,
		reason: 'overriding host MTUs on start needs root@pam',
	},
	{
		param: 'keepActive',
		path: QEMU_STOP,
		reason: 'keeping the VM active after stop needs root@pam',
	},
	{
		param: 'migration_type',
		path: QEMU_GUEST,
		reason: 'choosing the migration transport needs root@pam',
	},
	{
		param: 'migration_network',
		path: QEMU_GUEST,
		reason: 'choosing the migration network needs root@pam',
	},
	{
		param: 'dev[n]',
		path: LXC_CREATE_OR_CONFIG,
		reason: 'passing a host device into a container needs root@pam',
	},
	{
		param: 'rootfs',
		path: LXC_CREATE_OR_CONFIG,
		reason: 'a bind or device rootfs needs root@pam; a storage volume does not',
		applies: isNonVolumeMountPoint,
	},
	{
		param: 'mp[n]',
		path: LXC_CREATE_OR_CONFIG,
		reason: 'bind and device mount points need root@pam; a storage volume does not',
		applies: isNonVolumeMountPoint,
	},
	{
		param: 'features',
		path: LXC_CREATE_OR_CONFIG,
		reason: 'container features other than nesting need root@pam',
		applies: usesPrivilegedLxcFeature,
	},
	{
		param: 'cmd',
		path: NODE_SHELL,
		reason: 'a shell command other than login needs root@pam',
		applies: (value) => text(value) !== 'login',
	},
]

/** The handlers test these parameters with Perl truthiness, so an off flag passes. */
function isSet(value: unknown): boolean {
	return (
		value !== undefined &&
		value !== null &&
		value !== false &&
		value !== 0 &&
		value !== '0' &&
		value !== ''
	)
}

function ruleFor(name: string, path: string): RootOnlyParamRule | undefined {
	const family = splitIndexedKey(name)
	const indexed = family ? `${family.base}[n]` : undefined
	return ROOT_ONLY_PARAM_RULES.find(
		(rule) => rule.path.test(path) && (rule.param === name || rule.param === indexed),
	)
}

/**
 * Parameters in this call that need a root@pam ticket.
 *
 * `path` is the registry template, such as `/nodes/{node}/lxc/{vmid}/config`.
 * `params` keys are the concrete names a caller passes, so `mp0` is matched
 * against the `mp[n]` rule.
 */
export function rootOnlyParams(method: string, path: string, params?: object): RootOnlyParamHit[] {
	if (!params) return []
	const documented = DOCUMENTED_ROOT_ONLY_PARAMS[`${method} ${path}`] ?? []
	const entries: [string, unknown][] = Object.entries(params)
	const hits: RootOnlyParamHit[] = []
	for (const [name, value] of entries) {
		if (!isSet(value)) continue
		const rule = ruleFor(name, path)
		if (rule) {
			if (!rule.applies || rule.applies(value)) hits.push({ param: name, reason: rule.reason })
		} else if (documented.includes(name)) {
			hits.push({ param: name, reason: 'the API schema marks this parameter as root-only' })
		}
	}
	return hits
}

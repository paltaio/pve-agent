/**
 * Watches a worker task by UPID, reads its log, then triggers each error
 * class the library throws and prints it by kind.
 *
 *   PVE_ENV_FILE=./pve.env PVE_TARGET_VMID=101 bun run examples/tasks-and-errors.ts
 *
 * Reads PVE_TARGET_VMID, a running Linux VM with the guest agent, and
 * PVE_NODE (default: the PVE_NODE of the env file) for the shell policy
 * check. The target's notes are changed through an asynchronous config
 * write and restored before the script exits. The shell check needs an SSH
 * key for root on the node, or a root@pam ticket in the env file.
 */

import pve, {
	formatPropertyString,
	GuestCommandError,
	loadCredentials,
	PveClient,
	PveCluster,
	PveError,
	PveNotFoundError,
	PvePropertyError,
	PveShellPolicyError,
	PveTierError,
	PveTimeoutError,
	PveVm,
} from '../src/index.ts'

const SECOND = 1000
const MINUTE = 60 * SECOND

function env(name: string, fallback?: string): string {
	const value = process.env[name] ?? fallback
	if (value === undefined) {
		console.error(`usage: ${name}=... PVE_ENV_FILE=./pve.env bun run examples/tasks-and-errors.ts`)
		process.exit(1)
	}
	return value
}

const TARGET_VMID = Number(env('PVE_TARGET_VMID'))

function detail(error: PveError): string {
	if (error instanceof PveTierError) {
		return `required ${error.required} available ${error.available.join(',') || 'none'}`
	}
	if (error instanceof PveNotFoundError) return `${error.method} ${error.path}`
	if (error instanceof GuestCommandError) return `vmid ${error.vmid} exit ${error.exitCode}`
	if (error instanceof PveShellPolicyError) return `shell ${error.shell}`
	if (error instanceof PveTimeoutError) return `${error.what} after ${error.waitedMs} ms`
	if (error instanceof PvePropertyError) return 'property string'
	return ''
}

async function expectError(label: string, call: () => Promise<unknown>): Promise<void> {
	try {
		await call()
	} catch (error) {
		if (!(error instanceof PveError)) throw error
		console.log(`${label}: ${error.constructor.name} kind ${error.kind} ${detail(error)}`)
		console.log(`  ${error.message}`)
		return
	}
	throw new Error(`${label}: the call succeeded`)
}

await using cluster = await pve.connect()
const node = cluster.node(process.env['PVE_NODE'])

const vm = await cluster.guest(TARGET_VMID)
if (!(vm instanceof PveVm)) {
	console.error(`guest ${TARGET_VMID} is a container; PVE_TARGET_VMID names a VM`)
	process.exit(1)
}
const status = await vm.status()
if (status.runState === 'paused') await vm.resume()
if (status.runState === 'stopped') await vm.start()
await vm.waitFor('running', { timeoutMs: 2 * MINUTE })
await vm.waitForAgent({ timeoutMs: 3 * MINUTE })

const notes = await vm.notes()
try {
	const upid = await vm.api.setConfigAsync({ description: `pve-agent-example ${Date.now()}` })
	console.log(`task ${upid}`)
	const done = await cluster.waitForTask(upid, { timeoutMs: MINUTE })
	console.log(`task ${done.type} ${done.status} exit ${done.exitStatus} outcome ${done.outcome}`)
	const log = await cluster.client.taskLog(upid)
	console.log(`task log ${log.length} lines: ${log.join(' | ')}`)
} finally {
	if (notes === undefined) await vm.api.deleteConfigKeys('description')
	else await vm.setNotes(notes)
}

await expectError('not-found', () => cluster.guest(999_999))

const execute = `/nodes/${node.name}/execute`
const decision = cluster.client.requiredTier('POST', execute)
console.log(`requiredTier POST ${execute}: ${decision.tier}, root@pam ${decision.requiresRootPam}`)
console.log(`  ${decision.reason}`)
const { connection, token } = loadCredentials()
await using tokenOnly = new PveCluster(
	new PveClient({ credentials: token === undefined ? { connection } : { connection, token } }),
)
await expectError('tier', () => tokenOnly.client.post(execute, { commands: '[]' }))

await expectError('guest-command', () => vm.guest.output(['sh', '-c', 'exit 3']))

await expectError('shell-policy', async () => (await node.shell).run('rm -rf /'))

await expectError('timeout', () =>
	vm.kvm.waitForScreen({ kind: 'color', color: '#000000', area: 2 }, { timeoutMs: SECOND }),
)
await vm.kvm.close()

await expectError('property', () =>
	Promise.resolve(formatPropertyString({ model: 'virtio', bridge: 'vmbr0,vmbr1' })),
)

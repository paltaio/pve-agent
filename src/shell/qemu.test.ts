import { describe, expect, test } from 'bun:test'
import { PveShellPolicyError } from './errors.ts'
import { NodeShell } from './node-shell.ts'
import { parseGuestConfig, parseGuestExec, parseMonitorOutput, parseQmList } from './qemu.ts'
import { FakeTransport } from './test-support.ts'

const QM_LIST = `      VMID NAME                 STATUS     MEM(MB)    BOOTDISK(GB) PID
       100 oldlinux-target-1    stopped    2048              16.00 0
       101 linux-target-1       running    4096              32.00 1882584
       102                      running    16384              0.09 1882390
`

const GUEST_EXEC = `{
   "exitcode" : 0,
   "exited" : 1,
   "out-data" : "debian-vm\\n",
   "out-truncated" : 0
}`

describe('parseQmList', () => {
	test('reads every column and treats pid 0 as no process', () => {
		const entries = parseQmList(QM_LIST)
		expect(entries).toHaveLength(3)
		expect(entries[0]).toEqual({
			vmid: 100,
			name: 'oldlinux-target-1',
			status: 'stopped',
			memoryMb: 2048,
			bootDiskGb: 16,
			pid: undefined,
		})
		expect(entries[1]?.pid).toBe(1882584)
	})

	test('a VM without a name leaves the name empty', () => {
		expect(parseQmList(QM_LIST)[2]).toMatchObject({ vmid: 102, name: '', status: 'running' })
	})
})

describe('parseGuestConfig', () => {
	test('reads key: value lines and keeps a value that holds a colon', () => {
		const config = parseGuestConfig(
			'name: vm\nscsi0: local-zfs:vm-100-disk-0,size=32G\nlock: backup\n',
		)
		expect(config).toEqual({
			name: 'vm',
			scsi0: 'local-zfs:vm-100-disk-0,size=32G',
			lock: 'backup',
		})
	})
})

describe('parseMonitorOutput', () => {
	test('drops the banner and the carriage returns', () => {
		expect(
			parseMonitorOutput(
				"Entering QEMU Monitor for VM 101 - type 'help' for help\nVM status: running\r\n",
			),
		).toBe('VM status: running')
	})
})

describe('parseGuestExec', () => {
	test('reads the agent reply', () => {
		expect(parseGuestExec(GUEST_EXEC)).toEqual({
			exitCode: 0,
			exited: true,
			stdout: 'debian-vm\n',
			stderr: '',
			truncated: false,
		})
	})

	test('something other than an object is an error', () => {
		expect(() => parseGuestExec('42')).toThrow(TypeError)
	})
})

describe('qm command lines', () => {
	test('list, config and status', async () => {
		const transport = new FakeTransport({
			reply: (command) =>
				command === 'qm list'
					? { stdout: QM_LIST }
					: command.startsWith('qm config')
						? { stdout: 'name: linux-target-1\n' }
						: { stdout: 'status: running\n' },
		})
		const qm = new NodeShell(transport).qm
		expect((await qm.list()).map((entry) => entry.vmid)).toEqual([100, 101, 102])
		expect((await qm.config(101))['name']).toBe('linux-target-1')
		await qm.config(101, { current: true, snapshot: 'before' })
		expect(await qm.status(101)).toBe('running')
		expect(transport.commands).toEqual([
			'qm list',
			'qm config 101',
			'qm config 101 --current 1 --snapshot before',
			'qm status 101',
		])
	})

	test('the lifecycle verbs carry their qm timeouts in seconds', async () => {
		const transport = new FakeTransport()
		const qm = new NodeShell(transport, { destructive: 'allow' }).qm
		await qm.start(101, { timeoutMs: 9 })
		await qm.stop(101, { timeoutSeconds: 30, overruleShutdown: true })
		await qm.shutdown(101, { timeoutSeconds: 60, forceStop: true })
		await qm.reboot(101, { timeoutSeconds: 45 })
		expect(transport.commands).toEqual([
			'qm start 101',
			'qm stop 101 --timeout 30 --overrule-shutdown 1',
			'qm shutdown 101 --timeout 60 --forceStop 1',
			'qm reboot 101 --timeout 45',
		])
		expect(transport.calls[0]?.options).toEqual({ check: true, timeoutMs: 9 })
	})

	test('set, sendkey and unlock', async () => {
		const transport = new FakeTransport()
		const qm = new NodeShell(transport).qm
		await qm.set(101, { memory: 2048, description: 'two words' })
		await qm.sendkey(101, 'ctrl-alt-delete')
		await qm.unlock(101)
		expect(transport.commands).toEqual([
			"qm set 101 --memory 2048 --description 'two words'",
			'qm sendkey 101 ctrl-alt-delete',
			'qm unlock 101',
		])
	})

	test('monitor feeds the command on stdin and returns the reply', async () => {
		const transport = new FakeTransport({
			reply: () => ({
				stdout: "Entering QEMU Monitor for VM 101 - type 'help' for help\nVM status: running\r\n",
			}),
		})
		expect(await new NodeShell(transport).qm.monitor(101, 'info status')).toBe('VM status: running')
		expect(transport.commands[0]).toBe('qm monitor 101')
		expect(transport.calls[0]?.options.input).toBe('info status\n')
	})

	test('guestExec passes the argument vector after -- and parses the JSON reply', async () => {
		const transport = new FakeTransport({ reply: () => ({ stdout: GUEST_EXEC }) })
		const result = await new NodeShell(transport).qm.guestExec(101, ['cat', '/etc/host name'], {
			input: 'x',
			timeoutSeconds: 5,
		})
		expect(result.stdout).toBe('debian-vm\n')
		expect(transport.commands[0]).toBe(
			"qm guest exec 101 --pass-stdin 1 --timeout 5 -- cat '/etc/host name'",
		)
		expect(transport.calls[0]?.options.input).toBe('x')
	})

	test('imports run with a long default timeout', async () => {
		const transport = new FakeTransport()
		const qm = new NodeShell(transport).qm
		await qm.importDisk(9001, '/mnt/images/disk.qcow2', 'local-zfs', {
			format: 'raw',
			targetDisk: 'scsi1',
		})
		await qm.importOvf(9001, '/mnt/images/appliance.ovf', 'local-zfs', { timeoutMs: 10 })
		expect(transport.commands).toEqual([
			'qm importdisk 9001 /mnt/images/disk.qcow2 local-zfs --format raw --target-disk scsi1',
			'qm importovf 9001 /mnt/images/appliance.ovf local-zfs',
		])
		expect(transport.calls[0]?.options.timeoutMs).toBe(3_600_000)
		expect(transport.calls[1]?.options.timeoutMs).toBe(10)
	})

	test('showCommand, rescan, nbdStop, enrollEfiKeys and cleanup', async () => {
		const transport = new FakeTransport({ reply: () => ({ stdout: '/usr/bin/kvm -id 100\n' }) })
		const qm = new NodeShell(transport, { destructive: 'allow' }).qm
		expect(await qm.showCommand(100, { pretty: true, snapshot: 's1' })).toBe('/usr/bin/kvm -id 100')
		await qm.rescan({ vmid: 100, dryRun: true })
		await qm.rescan()
		await qm.nbdStop(100)
		await qm.enrollEfiKeys(100)
		await qm.cleanup(100, { cleanShutdown: true })
		expect(transport.commands).toEqual([
			'qm showcmd 100 --pretty 1 --snapshot s1',
			'qm rescan --vmid 100 --dryrun 1',
			'qm rescan',
			'qm nbdstop 100',
			'qm enroll-efi-keys 100',
			'qm cleanup 100 --keep-active 0 --clean-shutdown 1',
		])
	})

	test('a guest id that is not a number never reaches a command', async () => {
		const transport = new FakeTransport()
		const qm = new NodeShell(transport).qm
		expect(() => qm.nbdStop('9060 --skiplock' as unknown as number)).toThrow(/vmid/)
		expect(() =>
			qm.importDisk('9060 --format raw' as unknown as number, '/tmp/disk.raw', 'local'),
		).toThrow(/vmid/)
		expect(() => qm.rescan({ vmid: Number.NaN })).toThrow(PveShellPolicyError)
		expect(() => qm.stop(100, { timeoutSeconds: '1; reboot' as unknown as number })).toThrow(
			/timeoutSeconds/,
		)
		expect(transport.commands).toEqual([])
	})
})

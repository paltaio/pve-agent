import { describe, expect, test } from 'bun:test'
import { PveShellPolicyError } from './errors.ts'
import { parsePctDf, parsePctList } from './lxc.ts'
import { NodeShell } from './node-shell.ts'
import { FakeTransport } from './test-support.ts'

const PCT_LIST = `VMID       Status     Lock         Name
110        running                 image-library
9002       stopped    snapshot     pve-agent-test-ct-with-a-long-name
`

const PCT_DF = [
	'MP     Volume                      Size   Used Avail Use% Path',
	'rootfs tank-vms:subvol-110-disk-0 32.0G   1.6G 30.4G  5.0 /',
	'mp0    tank-vms:subvol-110-disk-1  2.0T 359.0G  1.6T 17.5 /srv/images',
].join('\n')

describe('parsePctList', () => {
	test('reads the columns by header offset, so a blank lock does not shift the name', () => {
		expect(parsePctList(PCT_LIST)).toEqual([
			{ vmid: 110, status: 'running', lock: undefined, name: 'image-library' },
			{
				vmid: 9002,
				status: 'stopped',
				lock: 'snapshot',
				name: 'pve-agent-test-ct-with-a-long-name',
			},
		])
	})

	test('output without the header is no containers', () => {
		expect(parsePctList('')).toEqual([])
	})
})

describe('parsePctDf', () => {
	test('reads the columns pct prints and turns the sizes into bytes', () => {
		const rows = parsePctDf(PCT_DF)
		expect(rows).toHaveLength(2)
		expect(rows[0]).toMatchObject({
			mountPoint: 'rootfs',
			volume: 'tank-vms:subvol-110-disk-0',
			size: '32.0G',
			sizeBytes: 34359738368,
			usePercent: 5,
			path: '/',
		})
		expect(rows[1]?.path).toBe('/srv/images')
		expect(rows[1]?.usedBytes).toBe(385473314816)
	})
})

describe('pct exec', () => {
	test('wraps a command line in sh -c inside the container', async () => {
		const transport = new FakeTransport()
		await new NodeShell(transport).pct.exec(9060, 'id -u')
		expect(transport.commands[0]).toBe("pct exec 9060 -- sh -c 'id -u'")
	})

	test('quotes a command that contains quotes of its own', async () => {
		const transport = new FakeTransport()
		await new NodeShell(transport).pct.exec(9060, `printf '%s\\n' "it's here"`)
		expect(transport.commands[0]).toBe(
			`pct exec 9060 -- sh -c 'printf '\\''%s\\n'\\'' "it'\\''s here"'`,
		)
	})

	test('keepEnv, the shell, stdin and the deadline are passed through', async () => {
		const transport = new FakeTransport()
		await new NodeShell(transport).pct.exec(9060, 'cat', {
			shell: '/bin/bash',
			keepEnv: true,
			input: 'body',
			timeoutMs: 4,
		})
		expect(transport.commands[0]).toBe('pct exec 9060 --keep-env 1 -- /bin/bash -c cat')
		expect(transport.calls[0]?.options).toEqual({ input: 'body', timeoutMs: 4 })
	})

	test('an argument vector reaches the container without a shell', async () => {
		const transport = new FakeTransport()
		await new NodeShell(transport).pct.execArgv(9060, ['/bin/busybox', 'echo', 'two words'], {
			keepEnv: false,
		})
		expect(transport.commands[0]).toBe(
			"pct exec 9060 --keep-env 0 -- /bin/busybox echo 'two words'",
		)
	})

	test('the exit code comes back untouched', async () => {
		const transport = new FakeTransport({ reply: () => ({ exitCode: 42 }) })
		expect((await new NodeShell(transport).pct.exec(9060, 'exit 42')).exitCode).toBe(42)
	})
})

describe('reads', () => {
	test('list, config and status', async () => {
		const transport = new FakeTransport({
			reply: (command) =>
				command === 'pct list'
					? { stdout: PCT_LIST }
					: command.startsWith('pct config')
						? { stdout: 'arch: amd64\nhostname: probe\nlock: snapshot\n' }
						: { stdout: 'status: stopped\n' },
		})
		const pct = new NodeShell(transport).pct
		expect((await pct.list()).map((entry) => entry.vmid)).toEqual([110, 9002])
		const config = await pct.config(9060)
		expect(config['hostname']).toBe('probe')
		expect(config['lock']).toBe('snapshot')
		expect(await pct.status(9060)).toBe('stopped')
		expect(transport.commands).toEqual(['pct list', 'pct config 9060', 'pct status 9060'])
	})

	test('df names the container', async () => {
		const transport = new FakeTransport({ reply: () => ({ stdout: PCT_DF }) })
		expect(await new NodeShell(transport).pct.df(110)).toHaveLength(2)
		expect(transport.commands[0]).toBe('pct df 110')
	})
})

describe('lifecycle and maintenance', () => {
	test('each verb builds its pct line', async () => {
		const transport = new FakeTransport()
		const pct = new NodeShell(transport).pct
		await pct.start(9060)
		await pct.stop(9060, { overruleShutdown: true })
		await pct.shutdown(9060, { timeoutSeconds: 30, forceStop: true })
		await pct.reboot(9060, { timeoutSeconds: 10 })
		await pct.mount(9060)
		await pct.unmount(9060)
		await pct.unlock(9060)
		await pct.rescan({ vmid: 9060, dryRun: true })
		await pct.fsck(9060, { force: true, device: 'rootfs' })
		await pct.fstrim(9060, { ignoreMountpoints: true })
		expect(transport.commands).toEqual([
			'pct start 9060',
			'pct stop 9060 --overrule-shutdown 1',
			'pct shutdown 9060 --timeout 30 --forceStop 1',
			'pct reboot 9060 --timeout 10',
			'pct mount 9060',
			'pct unmount 9060',
			'pct unlock 9060',
			'pct rescan --vmid 9060 --dryrun 1',
			'pct fsck 9060 --force 1 --device rootfs',
			'pct fstrim 9060 --ignore-mountpoints 1',
		])
		expect(transport.calls.every((call) => call.options.check === true)).toBe(true)
	})
})

describe('file transfer', () => {
	test('push and pull carry the ownership flags', async () => {
		const transport = new FakeTransport()
		const pct = new NodeShell(transport).pct
		await pct.push(9060, '/tmp/on node', '/etc/motd', { perms: '0644', user: 0, group: 'wheel' })
		await pct.pull(9060, '/var/log/messages', '/tmp/messages')
		expect(transport.commands).toEqual([
			"pct push 9060 '/tmp/on node' /etc/motd --perms 0644 --user 0 --group wheel",
			'pct pull 9060 /var/log/messages /tmp/messages',
		])
	})

	test('a local file is uploaded to a temporary node path, pushed in and the path removed', async () => {
		const transport = new FakeTransport({
			reply: (command) =>
				command.startsWith('mktemp') ? { stdout: '/tmp/pve-agent.AbCdEf\n' } : {},
		})
		await new NodeShell(transport).pct.pushLocalFile(9060, './app.tar', '/opt/app.tar')
		expect(transport.uploads).toEqual([
			{ localPath: './app.tar', remotePath: '/tmp/pve-agent.AbCdEf' },
		])
		expect(transport.commands).toEqual([
			'mktemp /tmp/pve-agent.XXXXXX',
			'pct push 9060 /tmp/pve-agent.AbCdEf /opt/app.tar',
			'rm -- /tmp/pve-agent.AbCdEf',
		])
	})

	test('a pull to this machine goes through a temporary node path that is removed after', async () => {
		const transport = new FakeTransport({
			reply: (command) => (command.startsWith('mktemp') ? { stdout: '/tmp/pve-agent.XyZ\n' } : {}),
		})
		await new NodeShell(transport).pct.pullToLocalFile(9060, '/opt/report.json', './report.json')
		expect(transport.downloads).toEqual([
			{ remotePath: '/tmp/pve-agent.XyZ', localPath: './report.json' },
		])
		expect(transport.commands).toEqual([
			'mktemp /tmp/pve-agent.XXXXXX',
			'pct pull 9060 /opt/report.json /tmp/pve-agent.XyZ',
			'rm -- /tmp/pve-agent.XyZ',
		])
	})
})

describe('numbers in a pct command line', () => {
	test('a guest id that is not a number never reaches a command', async () => {
		const transport = new FakeTransport()
		const pct = new NodeShell(transport).pct
		expect(() => pct.exec('110 --output json' as unknown as number, 'ls')).toThrow(/vmid/)
		expect(() => pct.unlock(Number.NaN)).toThrow(PveShellPolicyError)
		expect(transport.commands).toEqual([])
	})

	test('a uid or gid that is not a number never reaches a command', async () => {
		const transport = new FakeTransport()
		const pct = new NodeShell(transport).pct
		expect(() => pct.push(9060, '/tmp/x', '/tmp/y', { user: Number.NaN })).toThrow(/user/)
		expect(() => pct.pull(9060, '/tmp/x', '/tmp/y', { group: Number.POSITIVE_INFINITY })).toThrow(
			/group/,
		)
		expect(transport.commands).toEqual([])
	})
})

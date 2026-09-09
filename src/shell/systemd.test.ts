import { describe, expect, test } from 'bun:test'
import { PveShellPolicyError } from './errors.ts'
import { NodeShell } from './node-shell.ts'
import { parseShowBlock } from './systemd.ts'
import { FakeTransport } from './test-support.ts'

const SHOW_OUTPUT = `MainPID=1638
Result=success
NRestarts=0
Id=pveproxy.service
Description=PVE API Proxy Server
LoadState=loaded
ActiveState=active
SubState=running
FragmentPath=/usr/lib/systemd/system/pveproxy.service
UnitFileState=enabled`

const UNIT_LIST =
	'apparmor.service                loaded    active   exited  Load AppArmor profiles\n' +
	'auditd.service                  not-found inactive dead    auditd.service\n'

describe('parseShowBlock', () => {
	test('reads the Key=Value block', () => {
		const properties = parseShowBlock(SHOW_OUTPUT)
		expect(properties['Id']).toBe('pveproxy.service')
		expect(properties['ActiveState']).toBe('active')
	})

	test('keeps a value that contains an equals sign', () => {
		expect(parseShowBlock('Environment=FOO=bar baz')['Environment']).toBe('FOO=bar baz')
	})

	test('ignores a line with no key', () => {
		expect(parseShowBlock('=novalue\nId=x')).toEqual({ Id: 'x' })
	})
})

describe('unit reads', () => {
	test('status turns the properties into a record', async () => {
		const transport = new FakeTransport({ reply: () => ({ stdout: SHOW_OUTPUT }) })
		const status = await new NodeShell(transport).systemd.status('pveproxy')
		expect(status.activeState).toBe('active')
		expect(status.subState).toBe('running')
		expect(status.unitFileState).toBe('enabled')
		expect(status.mainPid).toBe(1638)
		expect(transport.commands[0]).toBe(
			'systemctl show pveproxy --property=Id,Description,LoadState,ActiveState,SubState,UnitFileState,FragmentPath,MainPID,NRestarts,Result',
		)
	})

	test('listUnits splits the columns and keeps the description whole', async () => {
		const transport = new FakeTransport({ reply: () => ({ stdout: UNIT_LIST }) })
		const rows = await new NodeShell(transport).systemd.listUnits({
			type: 'service',
			state: 'failed',
			pattern: 'pve*',
		})
		expect(transport.commands[0]).toBe(
			"systemctl list-units --all --plain --no-legend --no-pager --type=service --state=failed 'pve*'",
		)
		expect(rows).toHaveLength(2)
		expect(rows[0]?.unit).toBe('apparmor.service')
		expect(rows[0]?.description).toBe('Load AppArmor profiles')
		expect(rows[1]?.load).toBe('not-found')
	})

	test('isActive and isEnabled read the one-word answers without checking the exit code', async () => {
		const transport = new FakeTransport({ reply: () => ({ stdout: 'inactive\n', exitCode: 3 }) })
		const systemd = new NodeShell(transport).systemd
		expect(await systemd.isActive('nginx')).toBe(false)
		expect(await systemd.isEnabled('nginx')).toBe(false)
		expect(transport.commands).toEqual(['systemctl is-active nginx', 'systemctl is-enabled nginx'])
		expect(transport.calls[0]?.options.check).toBeUndefined()
	})

	test('listTimers reads the timer units in one show call', async () => {
		const transport = new FakeTransport({
			reply: (command) =>
				command.startsWith('systemctl list-units')
					? { stdout: 'a.timer loaded active waiting A\nb.timer loaded active waiting B\n' }
					: {
							stdout:
								'Id=a.timer\nUnit=a.service\nNextElapseUSecRealtime=1725000000000000\nLastTriggerUSec=0\n\n' +
								'Id=b.timer\nUnit=b.service\nNextElapseUSecRealtime=18446744073709551615\nLastTriggerUSec=1724000000000000\n',
						},
		})
		const timers = await new NodeShell(transport).systemd.listTimers()
		expect(transport.commands[1]).toBe(
			'systemctl show a.timer b.timer --property=Id,Unit,NextElapseUSecRealtime,LastTriggerUSec',
		)
		expect(timers).toEqual([
			{
				unit: 'a.timer',
				service: 'a.service',
				nextElapseUsec: 1725000000000000,
				lastTriggerUsec: undefined,
			},
			{
				unit: 'b.timer',
				service: 'b.service',
				nextElapseUsec: undefined,
				lastTriggerUsec: 1724000000000000,
			},
		])
	})

	test('journal takes the unit and line count filters and returns lines', async () => {
		const transport = new FakeTransport({ reply: () => ({ stdout: 'one\ntwo\n' }) })
		const systemd = new NodeShell(transport).systemd
		expect(
			await systemd.journal({ unit: 'pvedaemon', lines: 5, since: '-1h', priority: 'err' }),
		).toEqual(['one', 'two'])
		expect(transport.commands[0]).toBe(
			'journalctl -q --no-pager -n 5 -u pvedaemon --since -1h -p err',
		)
	})

	test('an empty journal is an empty list', async () => {
		const transport = new FakeTransport()
		expect(await new NodeShell(transport).systemd.journal()).toEqual([])
		expect(transport.commands[0]).toBe('journalctl -q --no-pager -n 100')
	})
})

describe('unit control', () => {
	test('each verb builds its systemctl line and checks the exit code', async () => {
		const transport = new FakeTransport()
		const systemd = new NodeShell(transport).systemd
		await systemd.start('nginx', { timeoutMs: 7 })
		await systemd.stop('nginx')
		await systemd.restart('nginx')
		await systemd.reload('nginx')
		await systemd.enable('nginx', { now: true })
		await systemd.disable('nginx')
		await systemd.mask('nginx', { now: true })
		await systemd.unmask('nginx')
		await systemd.daemonReload()
		expect(transport.commands).toEqual([
			'systemctl start nginx',
			'systemctl stop nginx',
			'systemctl restart nginx',
			'systemctl reload nginx',
			'systemctl enable --now nginx',
			'systemctl disable nginx',
			'systemctl mask --now nginx',
			'systemctl unmask nginx',
			'systemctl daemon-reload',
		])
		expect(transport.calls[0]?.options).toEqual({ check: true, timeoutMs: 7 })
		expect(transport.calls[1]?.options).toEqual({ check: true })
	})
})

describe('unit files', () => {
	test('a unit file is written to /etc/systemd/system through a here-document and systemd is reloaded', async () => {
		const transport = new FakeTransport()
		const path = await new NodeShell(transport).systemd.writeUnit('probe.service', '[Unit]\n')
		expect(path).toBe('/etc/systemd/system/probe.service')
		expect(transport.commands[0]).toBe(
			"mkdir -p -- /etc/systemd/system && cat > /etc/systemd/system/probe.service <<'PVE_EOF' && chmod 0644 -- /etc/systemd/system/probe.service\n[Unit]\nPVE_EOF",
		)
		expect(transport.commands[1]).toBe('systemctl daemon-reload')
	})

	test('a drop-in goes into the unit.d directory, and reload can be skipped', async () => {
		const transport = new FakeTransport()
		const path = await new NodeShell(transport).systemd.writeUnit('pveproxy.service', '[Service]', {
			dropIn: 'limits',
			reload: false,
		})
		expect(path).toBe('/etc/systemd/system/pveproxy.service.d/limits.conf')
		expect(transport.commands).toHaveLength(1)
		expect(transport.commands[0]).toStartWith(
			'mkdir -p -- /etc/systemd/system/pveproxy.service.d && cat > /etc/systemd/system/pveproxy.service.d/limits.conf',
		)
		expect(transport.commands[0]).toEndWith('\n[Service]\nPVE_EOF')
	})

	test('readUnit and removeUnit address the same path', async () => {
		const transport = new FakeTransport({ reply: () => ({ stdout: '[Unit]\n' }) })
		const systemd = new NodeShell(transport).systemd
		expect(await systemd.readUnit('probe.service')).toBe('[Unit]')
		await systemd.removeUnit('probe.service', { dropIn: 'limits' })
		expect(transport.commands).toEqual([
			'cat -- /etc/systemd/system/probe.service',
			'rm -- /etc/systemd/system/probe.service.d/limits.conf',
			'systemctl daemon-reload',
		])
	})

	test('a unit or drop-in name that climbs out of /etc/systemd/system is refused', async () => {
		const transport = new FakeTransport()
		const systemd = new NodeShell(transport).systemd
		await expect(systemd.writeUnit('../../cron.d/x', 'payload')).rejects.toThrow(
			PveShellPolicyError,
		)
		await expect(
			systemd.writeUnit('pveproxy.service', 'payload', { dropIn: '../../../x' }),
		).rejects.toThrow(PveShellPolicyError)
		expect(() => systemd.readUnit('../../../etc/shadow')).toThrow(PveShellPolicyError)
		await expect(systemd.removeUnit('../../cron.d/x')).rejects.toThrow(PveShellPolicyError)
		expect(transport.commands).toEqual([])
	})
})

describe('values interpolated into a systemctl line', () => {
	test('show quotes the property list instead of interpolating it', async () => {
		const transport = new FakeTransport()
		await new NodeShell(transport).systemd.show('pveproxy', ['Id; touch /tmp/x'])
		expect(transport.commands[0]).toBe("systemctl show pveproxy '--property=Id; touch /tmp/x'")
	})

	test('showMany quotes the property list too', async () => {
		const transport = new FakeTransport()
		await new NodeShell(transport).systemd.showMany(['pveproxy'], ['Id; touch /tmp/x'])
		expect(transport.commands[0]).toBe("systemctl show pveproxy '--property=Id; touch /tmp/x'")
	})

	test('a journal line count has to be a number', async () => {
		const transport = new FakeTransport()
		await expect(
			new NodeShell(transport).systemd.journal({ lines: '5 -u pvestatd' as unknown as number }),
		).rejects.toThrow(/lines/)
		expect(transport.commands).toEqual([])
	})
})

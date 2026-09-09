import { describe, expect, test } from 'bun:test'
import { PveShellPolicyError } from './errors.ts'
import { NodeShell } from './node-shell.ts'
import { parseAptList, parseAptPolicy, parseAptSimulation, parseStanzas } from './packages.ts'
import { FakeTransport } from './test-support.ts'

const SIMULATION = `Reading package lists...
Building dependency tree...
Reading state information...
Calculating upgrade...
The following packages will be upgraded:
  pve-manager zfsutils-linux
Inst pve-manager [9.2.10] (9.2.11 Proxmox VE:stable [amd64])
Inst zfsutils-linux [2.4.3-pve1] (2.4.4-pve1 Proxmox VE:stable [amd64]) []
Inst brand-new-package (1.0 Debian:trixie [all])
Remv obsolete-package [3.2.1]
Conf pve-manager (9.2.11 Proxmox VE:stable [amd64])
2 upgraded, 1 newly installed, 1 to remove and 0 not upgraded.`

const UPGRADABLE = `Listing...
pve-manager/stable 9.2.11 all [upgradable from: 9.2.10]
zfsutils-linux/stable 2.4.4-pve1 amd64 [upgradable from: 2.4.3-pve1]
`

const POLICY = `pve-manager:
  Installed: 9.2.11
  Candidate: 9.2.11
  Version table:
 *** 9.2.11 500
        500 http://download.proxmox.com/debian/pve trixie/pve-no-subscription amd64 Packages
        100 /var/lib/dpkg/status
     9.2.10 500
        500 http://download.proxmox.com/debian/pve trixie/pve-no-subscription amd64 Packages
`

const SHOW = `Package: pve-manager
Architecture: all
Version: 9.2.11
Depends: apt (>= 1.5~),
 bash-completion
Description: Proxmox Virtual Environment Management Tools
 This package contains the Proxmox Virtual Environment management tools.

Package: pve-manager
Architecture: all
Version: 9.2.10
`

describe('parseAptSimulation', () => {
	test('reads upgrades, installs and removals', () => {
		const changes = parseAptSimulation(SIMULATION)
		expect(changes.map((change) => change.name)).toEqual([
			'pve-manager',
			'zfsutils-linux',
			'brand-new-package',
			'obsolete-package',
		])
		expect(changes[0]).toMatchObject({
			action: 'upgrade',
			currentVersion: '9.2.10',
			newVersion: '9.2.11',
			architecture: 'amd64',
		})
		expect(changes[2]).toMatchObject({ action: 'install', currentVersion: undefined })
		expect(changes[3]).toMatchObject({ action: 'remove', currentVersion: '3.2.1' })
	})

	test('an up-to-date node reports nothing', () => {
		expect(
			parseAptSimulation('0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.'),
		).toEqual([])
	})
})

describe('parseAptList', () => {
	test('reads the rows after the Listing line', () => {
		const rows = parseAptList(UPGRADABLE)
		expect(rows).toEqual([
			{
				name: 'pve-manager',
				suite: 'stable',
				newVersion: '9.2.11',
				architecture: 'all',
				currentVersion: '9.2.10',
			},
			{
				name: 'zfsutils-linux',
				suite: 'stable',
				newVersion: '2.4.4-pve1',
				architecture: 'amd64',
				currentVersion: '2.4.3-pve1',
			},
		])
	})

	test('an up-to-date node lists nothing', () => {
		expect(parseAptList('Listing...\n')).toEqual([])
	})
})

describe('parseAptPolicy', () => {
	test('reads the installed and candidate versions and the version table', () => {
		expect(parseAptPolicy(POLICY)).toEqual({
			installed: '9.2.11',
			candidate: '9.2.11',
			versions: [
				{ version: '9.2.11', priority: 500 },
				{ version: '9.2.10', priority: 500 },
			],
		})
	})

	test('(none) becomes undefined', () => {
		const policy = parseAptPolicy(
			'htop:\n  Installed: (none)\n  Candidate: 3.4.1-5\n  Version table:\n',
		)
		expect(policy.installed).toBeUndefined()
		expect(policy.candidate).toBe('3.4.1-5')
	})
})

describe('parseStanzas', () => {
	test('one record per stanza, with continuation lines folded into the field', () => {
		const stanzas = parseStanzas(SHOW)
		expect(stanzas).toHaveLength(2)
		expect(stanzas[0]?.['Version']).toBe('9.2.11')
		expect(stanzas[0]?.['Depends']).toBe('apt (>= 1.5~),\nbash-completion')
		expect(stanzas[0]?.['Description']).toStartWith(
			'Proxmox Virtual Environment Management Tools\n',
		)
		expect(stanzas[1]?.['Version']).toBe('9.2.10')
	})
})

describe('apt commands', () => {
	test('the queries run under LC_ALL=C', async () => {
		const transport = new FakeTransport({ reply: () => ({ stdout: SIMULATION }) })
		const apt = new NodeShell(transport).apt
		expect(await apt.pendingUpgrades()).toHaveLength(4)
		expect(transport.calls[0]?.command).toBe('apt-get -s dist-upgrade')
		expect(transport.calls[0]?.options.env).toEqual({ LC_ALL: 'C' })
		await apt.listUpgradable()
		expect(transport.calls[1]?.command).toBe('apt list --upgradable 2>/dev/null')
		await apt.policy('pve-manager')
		await apt.show('pve-manager')
		await apt.search('^pve-', { namesOnly: true })
		expect(transport.commands.slice(2)).toEqual([
			'apt-cache policy pve-manager',
			'apt-cache show pve-manager',
			"apt-cache search --names-only -- '^pve-'",
		])
	})

	test('search splits the name from the description', async () => {
		const transport = new FakeTransport({
			reply: () => ({ stdout: 'pve-manager - Proxmox Virtual Environment Management Tools\n' }),
		})
		expect(await new NodeShell(transport).apt.search('pve-manager')).toEqual([
			{ name: 'pve-manager', description: 'Proxmox Virtual Environment Management Tools' },
		])
	})

	test('install runs apt-get non-interactively and keeps the installed conffile', async () => {
		const transport = new FakeTransport()
		await new NodeShell(transport).apt.install(['htop', 'jq'], { recommends: false })
		expect(transport.commands[0]).toBe(
			'apt-get -y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold --no-install-recommends install htop jq',
		)
		expect(transport.calls[0]?.options).toEqual({
			check: true,
			env: { DEBIAN_FRONTEND: 'noninteractive' },
			timeoutMs: 900_000,
		})
	})

	test('update, upgrade and dist-upgrade take a timeout', async () => {
		const transport = new FakeTransport()
		const apt = new NodeShell(transport).apt
		await apt.update({ timeoutMs: 1 })
		await apt.upgrade()
		await apt.distUpgrade()
		expect(transport.commands.map((command) => command.split(' ').at(-1))).toEqual([
			'update',
			'upgrade',
			'dist-upgrade',
		])
		expect(transport.calls[0]?.options.timeoutMs).toBe(1)
	})

	test('remove, purge and autoremove are refused by the default policy', async () => {
		const transport = new FakeTransport()
		const apt = new NodeShell(transport).apt
		await expect(apt.remove(['htop'])).rejects.toThrow(PveShellPolicyError)
		await expect(apt.purge(['htop'])).rejects.toThrow(PveShellPolicyError)
		await expect(apt.autoremove()).rejects.toThrow(PveShellPolicyError)
		expect(transport.commands).toEqual([])
	})

	test('remove, purge and autoremove build their lines when the policy allows them', async () => {
		const transport = new FakeTransport()
		const apt = new NodeShell(transport, { destructive: 'allow' }).apt
		await apt.remove(['htop'])
		await apt.purge(['htop'])
		await apt.autoremove({ purge: true })
		expect(transport.commands.map((command) => command.split(' ').slice(6).join(' '))).toEqual([
			'remove htop',
			'purge htop',
			'autoremove --purge',
		])
	})

	test('holds', async () => {
		const transport = new FakeTransport({
			reply: () => ({ stdout: 'pve-kernel\nzfsutils-linux\n' }),
		})
		const apt = new NodeShell(transport).apt
		await apt.hold(['pve-kernel'])
		await apt.unhold(['pve-kernel'])
		expect(await apt.listHolds()).toEqual(['pve-kernel', 'zfsutils-linux'])
		expect(transport.commands).toEqual([
			'apt-mark hold pve-kernel',
			'apt-mark unhold pve-kernel',
			'apt-mark showhold',
		])
	})
})

describe('dpkg queries', () => {
	test('installedVersion reads the version and reports undefined for a package that is not there', async () => {
		const missing = new FakeTransport({ reply: () => ({ exitCode: 1 }) })
		expect(await new NodeShell(missing).apt.installedVersion('nope')).toBeUndefined()
		const present = new FakeTransport({ reply: () => ({ stdout: '9.2.11' }) })
		expect(await new NodeShell(present).apt.installedVersion('pve-manager')).toBe('9.2.11')
		expect(present.commands[0]).toBe("dpkg-query -W -f '${Version}' pve-manager 2>/dev/null")
	})

	test('listInstalled reads the tab separated rows', async () => {
		const transport = new FakeTransport({
			reply: () => ({ stdout: 'pve-manager\t9.2.11\tinstall ok installed\n' }),
		})
		expect(await new NodeShell(transport).apt.listInstalled('pve-*')).toEqual([
			{ name: 'pve-manager', version: '9.2.11', status: 'install ok installed' },
		])
		expect(transport.commands[0]).toBe(
			"dpkg-query -W -f '${Package}\\t${Version}\\t${Status}\\n' 'pve-*'",
		)
	})
})

describe('files under /etc/apt', () => {
	test('a repository file lands in sources.list.d through a here-document', async () => {
		const transport = new FakeTransport()
		const path = await new NodeShell(transport).apt.addRepository('pve.sources', 'Types: deb')
		expect(path).toBe('/etc/apt/sources.list.d/pve.sources')
		expect(transport.commands[0]).toBe(
			"cat > /etc/apt/sources.list.d/pve.sources <<'PVE_EOF'\nTypes: deb\nPVE_EOF",
		)
	})

	test('a keyring is written from base64 so binary bytes survive', async () => {
		const transport = new FakeTransport()
		const path = await new NodeShell(transport).apt.addKeyring(
			'vendor.gpg',
			new Uint8Array([0x99, 0x01, 0x0d]),
		)
		expect(path).toBe('/etc/apt/keyrings/vendor.gpg')
		expect(transport.commands[0]).toBe(
			'mkdir -p /etc/apt/keyrings && printf %s mQEN | base64 -d > /etc/apt/keyrings/vendor.gpg',
		)
	})

	test('a repository or keyring name that climbs out of its directory is refused', async () => {
		const transport = new FakeTransport()
		const apt = new NodeShell(transport).apt
		await expect(apt.addRepository('../../cron.d/x', 'Types: deb')).rejects.toThrow(
			PveShellPolicyError,
		)
		await expect(apt.addKeyring('../trusted.gpg.d/x.gpg', 'key')).rejects.toThrow(
			PveShellPolicyError,
		)
		expect(transport.commands).toEqual([])
	})
})

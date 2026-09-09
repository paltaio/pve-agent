import { describe, expect, test } from 'bun:test'
import { PveShellPolicyError } from './errors.ts'
import { CommandPolicy, commandPrograms } from './policy.ts'

describe('the default policy', () => {
	const policy = new CommandPolicy()

	test('lets inspection and ordinary writes through', () => {
		for (const command of [
			'zpool status',
			'zfs list -Hp -o name,used',
			'systemctl restart pveproxy',
			'apt-get install -y htop',
			'echo x > /etc/motd',
			'rm /tmp/one-file',
		]) {
			expect(policy.explain(command).allowed).toBe(true)
		}
	})

	test('refuses the destructive patterns', () => {
		for (const command of [
			'rm -rf /',
			'zpool destroy tank',
			'zfs destroy -r tank/data',
			'mkfs.ext4 /dev/sdb1',
			'dd if=/dev/zero of=/dev/sdb bs=1M',
			'apt-get remove pve-manager',
			'pct destroy 110',
			'reboot',
			'lvremove /dev/pve/data',
			'wipefs -a /dev/nvme0n1',
			'cryptsetup luksFormat /dev/sdb',
			'zfs rollback tank/data@yesterday',
			'find /tmp -name "*.tmp" -delete',
			'cat /etc/hosts && shutdown -h now',
		]) {
			expect(policy.explain(command).allowed).toBe(false)
		}
	})

	test('host power words only count at the command position', () => {
		for (const command of [
			'qm shutdown 101',
			'qm shutdown 101 --timeout 60 --forceStop 1',
			'qm reboot 101 --timeout 45',
			'pct reboot 9002',
			'pct shutdown 9060 --timeout 30',
			'qm cleanup --clean-shutdown 1',
			'qm guest cmd 101 shutdown',
			'systemctl restart pvestatd',
			'journalctl -u systemd-halt.service',
		]) {
			expect(policy.explain(command).allowed).toBe(true)
		}
		for (const command of [
			'reboot',
			'shutdown -h now',
			'poweroff',
			'halt',
			'/sbin/reboot',
			'sudo halt',
			'true; poweroff',
			'echo ok && reboot',
			'echo ok || reboot',
			'echo ok | shutdown -r now',
			'echo $(reboot)',
			'echo `halt`',
		]) {
			expect(policy.explain(command).allowed).toBe(false)
		}
	})

	test('rm is refused with -r or -f anywhere in its arguments', () => {
		for (const command of [
			'rm -v -r /',
			'rm -i -rf /var',
			'rm /var -rf',
			"rm '-rf' /",
			'rm "-r" /var',
			'\\rm -rf /tmp/x',
			'rm --recursive /var',
			'echo / | xargs rm -rf',
			"sh -c 'rm -rf /'",
		]) {
			expect(policy.explain(command).allowed, command).toBe(false)
		}
		expect(policy.explain('rm -- -rf').allowed).toBe(false)
		expect(policy.explain('rm /tmp/one-file /tmp/-r').allowed).toBe(true)
	})

	test('a wrapper in front of a power word does not hide it', () => {
		for (const command of [
			'env reboot',
			'env -i FOO=1 reboot',
			'exec reboot',
			'nohup reboot',
			'nice -n 10 reboot',
			'ionice -c 3 reboot',
			'timeout 5 reboot',
			'timeout -s KILL 5 poweroff',
			'command reboot',
			'sudo -u root env X=1 halt',
			'doas -u root reboot',
			'busybox poweroff',
			'bash -c "reboot"',
			"sh -c 'echo ok; halt'",
			'\\reboot',
		]) {
			expect(policy.explain(command).allowed, command).toBe(false)
		}
	})

	test('init runlevels, systemctl targets and the sysrq trigger are power changes', () => {
		for (const command of [
			'init 6',
			'telinit 0',
			'init -t 5 0',
			'systemctl start reboot.target',
			'systemctl --no-block isolate poweroff.target',
			'systemctl start halt.target',
			'systemctl isolate kexec.target',
			'echo b > /proc/sysrq-trigger',
			'echo o | tee /proc/sysrq-trigger',
		]) {
			expect(policy.explain(command).allowed, command).toBe(false)
		}
		for (const command of [
			'init 3',
			'systemctl start pveproxy',
			'systemctl isolate multi-user.target',
		]) {
			expect(policy.explain(command).allowed, command).toBe(true)
		}
	})

	test('a redirect onto a zvol or a by-id device is refused', () => {
		expect(policy.explain('cat x > /dev/zvol/rpool/data/vm-100-disk-0').allowed).toBe(false)
		expect(policy.explain('cat x > /dev/disk/by-id/nvme-eui.1').allowed).toBe(false)
		expect(policy.explain("cat x > '/dev/sda'").allowed).toBe(false)
		expect(policy.explain('cat x > /dev/null').allowed).toBe(true)
	})

	test('a command nested in pct exec or qm guest exec is read as its own', () => {
		expect(policy.explain('pct exec 9002 -- rm -rf /tmp/x').allowed).toBe(false)
		expect(policy.explain('qm guest exec 101 -- mkfs.ext4 /dev/vdb').allowed).toBe(false)
		expect(policy.explain('pct exec 9002 -- rm /tmp/x').allowed).toBe(true)
	})

	test('check throws a policy error naming the reason', () => {
		const error = (() => {
			try {
				policy.check('zpool destroy tank')
			} catch (caught) {
				return caught
			}
			return undefined
		})()
		expect(error).toBeInstanceOf(PveShellPolicyError)
		if (error instanceof PveShellPolicyError) {
			expect(error.command).toBe('zpool destroy tank')
			expect(error.reason).toContain('zpool state change')
		}
	})

	test("destructive: 'allow' turns the built-in patterns off", () => {
		expect(new CommandPolicy({ destructive: 'allow' }).explain('zpool destroy tank').allowed).toBe(
			true,
		)
	})
})

describe('deny patterns', () => {
	test('a string denies the program in any position of the line', () => {
		const policy = new CommandPolicy({ deny: ['tee'] })
		expect(policy.explain('tee /etc/x').allowed).toBe(false)
		expect(policy.explain('zpool status | /usr/bin/tee /etc/x').allowed).toBe(false)
		expect(policy.explain('zpool status; LC_ALL=C tee /etc/x').allowed).toBe(false)
		expect(policy.explain('teeth').allowed).toBe(true)
	})

	test('a string sees through wrappers, a backslash and a brace group', () => {
		const policy = new CommandPolicy({ deny: ['rm'] })
		for (const command of [
			'sudo rm /tmp/x',
			'env rm /tmp/x',
			'\\rm /tmp/x',
			'{ rm -x; }',
			'timeout 5 /bin/rm /tmp/x',
			"sh -c 'rm /tmp/x'",
			'find /tmp | xargs rm',
		]) {
			expect(policy.explain(command).allowed, command).toBe(false)
		}
		expect(policy.explain('{ ls; }').allowed).toBe(true)
	})

	test('a regular expression is tested against the whole line', () => {
		const policy = new CommandPolicy({ deny: [/pveproxy/] })
		expect(policy.explain('systemctl restart pveproxy').allowed).toBe(false)
		expect(policy.explain('systemctl restart pvestatd').allowed).toBe(true)
	})

	test('deny wins over allow and the reason names the pattern', () => {
		const policy = new CommandPolicy({ allow: ['systemctl'], deny: [/restart/] })
		const decision = policy.explain('systemctl restart pveproxy')
		expect(decision.allowed).toBe(false)
		expect(decision.reason).toContain('/restart/')
	})
})

describe('allow patterns', () => {
	const policy = new CommandPolicy({ allow: ['zpool', 'zfs', /^cat \/etc\//] })

	test('a command has to match one of them', () => {
		expect(policy.explain('zpool status').allowed).toBe(true)
		expect(policy.explain('cat /etc/hosts').allowed).toBe(true)
		expect(policy.explain('cat /root/.ssh/id_ed25519').allowed).toBe(false)
		expect(policy.explain('systemctl stop pveproxy').allowed).toBe(false)
	})

	test('a program match is by base name and applies to the first command of the line', () => {
		expect(policy.explain('/sbin/zpool status').allowed).toBe(true)
		expect(policy.explain('zpool status | grep ONLINE').allowed).toBe(true)
	})

	test('a substitution is refused because the allow list cannot see inside it', () => {
		for (const command of [
			'zpool status $(systemctl stop pveproxy)',
			'zfs list `systemctl stop pveproxy`',
			'cat /etc/hosts <(systemctl stop pveproxy)',
		]) {
			const decision = policy.explain(command)
			expect(decision.allowed).toBe(false)
			expect(decision.reason).toContain('substitution')
		}
	})

	test('the built-in destructive patterns still apply', () => {
		expect(policy.explain('zpool destroy tank').allowed).toBe(false)
	})
})

describe('commandPrograms', () => {
	test('names the program of each command in the line', () => {
		expect(commandPrograms('zpool status | grep -c ONLINE && echo ok')).toEqual([
			'zpool',
			'grep',
			'echo',
		])
		expect(commandPrograms('cat /etc/hosts & rm /tmp/x')).toEqual(['cat', 'rm'])
		expect(commandPrograms('cat /etc/hosts 2>&1')).toEqual(['cat'])
	})

	test('skips variable assignments and strips the directory', () => {
		expect(commandPrograms("LC_ALL=C '/usr/bin/apt-get' -s upgrade")).toEqual(['apt-get'])
		expect(commandPrograms('(cd /tmp; ls)')).toEqual(['cd', 'ls'])
		expect(commandPrograms('dd if=/dev/zero of=/tmp/x')).toEqual(['dd'])
	})

	test('lists a wrapper with the program it runs', () => {
		expect(commandPrograms('sudo -u root env X=1 zfs list')).toEqual(['sudo', 'env', 'zfs'])
		expect(commandPrograms('timeout 5 zpool status')).toEqual(['timeout', 'zpool'])
		expect(commandPrograms("bash -c 'zfs list | grep data'")).toEqual(['bash', 'zfs', 'grep'])
		expect(commandPrograms('echo $(reboot)')).toEqual(['echo', 'reboot'])
		expect(commandPrograms('{ rm -x; }')).toEqual(['rm'])
	})
})

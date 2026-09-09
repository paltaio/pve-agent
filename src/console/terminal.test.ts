import { describe, expect, test } from 'bun:test'
import type { PveClient } from '../core/client.ts'
import { PveConfigError, PveConsoleError, PveTimeoutError } from '../core/errors.ts'
import { FakePty, type FakePtyOptions } from '../shell/test-support.ts'
import { keySequence, SerialConsole, type SerialConsoleOptions } from './terminal.ts'

function newConsole(options: Partial<SerialConsoleOptions> = {}): SerialConsole {
	return new SerialConsole({
		client: undefined as unknown as PveClient,
		node: 'ms02-0078',
		vmid: 101,
		cols: 40,
		rows: 6,
		connectTimeoutMs: 1000,
		keepaliveMs: 0,
		...options,
	})
}

/** A console attached to a fake pty and past the OK exchange. */
async function connected(
	options: Partial<SerialConsoleOptions> = {},
	pty: FakePtyOptions = {},
): Promise<{ serial: SerialConsole; socket: FakePty }> {
	const socket = new FakePty(pty)
	const serial = newConsole(options)
	await serial.attach(socket, 'root@pam', 'TICKET')
	return { serial, socket }
}

/** Frames sent after the login and the window size. */
function typed(socket: FakePty): string[] {
	return socket.sent.slice(2)
}

describe('key sequences', () => {
	test('named keys and control letters', () => {
		expect(keySequence('enter')).toBe('\r')
		expect(keySequence('tab')).toBe('\t')
		expect(keySequence('escape')).toBe('\x1b')
		expect(keySequence('ctrl-c')).toBe('\x03')
		expect(keySequence('ctrl-d')).toBe('\x04')
		expect(keySequence('up')).toBe('\x1b[A')
		expect(keySequence('left')).toBe('\x1b[D')
		expect(keySequence('f5')).toBe('\x1b[15~')
	})

	test('an unknown key is a config error', () => {
		const key = 'hyper-q' as Parameters<typeof keySequence>[0]
		expect(() => keySequence(key)).toThrow(PveConfigError)
	})
})

describe('the handshake', () => {
	test('logs in on an open socket and sends the window size after OK', async () => {
		const { serial, socket } = await connected()
		expect(socket.sent).toEqual(['root@pam:TICKET\n', '1:40:6:'])
		expect(serial.connected).toBe(true)
		expect(serial.cols).toBe(40)
		expect(serial.rows).toBe(6)
	})

	test('takes an OK split across frames and keeps output sharing its frame', async () => {
		const socket = new FakePty({ answerAuth: false })
		const serial = newConsole()
		const opened = serial.attach(socket, 'root@pam', 'TICKET')
		socket.emit('O')
		socket.emit('Klogin: ')
		await opened
		expect(serial.connected).toBe(true)
		await serial.waitForText('login:', { timeoutMs: 500 })
	})

	test('rejects when the proxy answers with anything but OK', async () => {
		const socket = new FakePty({ answerAuth: false })
		const serial = newConsole()
		const opened = serial.attach(socket, 'root@pam', 'stale')
		socket.emit('ERR ticket expired')
		await expect(opened).rejects.toThrow(/rejected the ticket/)
		expect(serial.connected).toBe(false)
		expect(socket.closes).toBe(1)
	})

	test('rejects when the socket closes before the answer', async () => {
		const socket = new FakePty({ answerAuth: false })
		const opened = newConsole().attach(socket, 'root@pam', 'TICKET')
		socket.close()
		await expect(opened).rejects.toThrow(/closed before the terminal proxy answered/)
	})

	test('rejects on its own timeout', async () => {
		const socket = new FakePty({ answerAuth: false })
		const opened = newConsole({ connectTimeoutMs: 20 }).attach(socket, 'root@pam', 'TICKET')
		await expect(opened).rejects.toThrow(/did not answer within 20ms/)
		expect(socket.closes).toBe(1)
	})

	test('refuses a second socket', async () => {
		const { serial } = await connected()
		expect(() => serial.attach(new FakePty(), 'root@pam', 'TICKET')).toThrow(/already has a socket/)
	})
})

describe('connect', () => {
	function stubClient(posts: { path: string; params: unknown }[]): PveClient {
		return {
			baseUrl: 'https://192.168.80.21:8006',
			auth: { has: () => false, tokenHeader: () => 'PVEAPIToken=x' },
			http: { verifySsl: false },
			post: async (path: string, params: unknown) => {
				posts.push({ path, params })
				return { port: 5900, ticket: 'TICKET', user: 'root@pam' }
			},
		} as unknown as PveClient
	}

	test('asks for the serial port of a VM and logs in with the ticket', async () => {
		const posts: { path: string; params: unknown }[] = []
		const opened: { url: string; headers: Record<string, string> }[] = []
		const socket = new FakePty()
		const serial = newConsole({
			client: stubClient(posts),
			serial: 'serial1',
			socketFactory: (url, options) => {
				opened.push({ url, headers: options.headers })
				return socket
			},
		})
		await serial.connect()
		expect(posts).toEqual([
			{ path: '/nodes/ms02-0078/qemu/101/termproxy', params: { serial: 'serial1' } },
		])
		expect(opened[0]?.url).toBe(
			'wss://192.168.80.21:8006/api2/json/nodes/ms02-0078/qemu/101/vncwebsocket?port=5900&vncticket=TICKET',
		)
		expect(opened[0]?.headers).toEqual({ Authorization: 'PVEAPIToken=x' })
		expect(socket.sent[0]).toBe('root@pam:TICKET\n')
		serial.close()
	})

	test('a container is asked for its one console', async () => {
		const posts: { path: string; params: unknown }[] = []
		const serial = newConsole({
			client: stubClient(posts),
			type: 'lxc',
			vmid: 110,
			socketFactory: () => new FakePty(),
		})
		await serial.connect()
		expect(posts).toEqual([{ path: '/nodes/ms02-0078/lxc/110/termproxy', params: {} }])
		serial.close()
	})

	test('closes the socket it opened when the handshake fails', async () => {
		const socket = new FakePty({ answerAuth: false })
		const serial = newConsole({
			client: stubClient([]),
			connectTimeoutMs: 20,
			socketFactory: () => socket,
		})
		await expect(serial.connect()).rejects.toThrow(/did not answer/)
		expect(socket.closes).toBe(1)
	})
})

describe('input', () => {
	test('write, sendLine and sendKey frame what they send', async () => {
		const { serial, socket } = await connected()
		serial.write('ls')
		serial.sendLine('uptime')
		serial.sendKey('ctrl-c')
		serial.sendKey('enter')
		expect(typed(socket)).toEqual(['0:2:ls', '0:7:uptime\r', '0:1:\x03', '0:1:\r'])
	})

	test('resize moves the emulator and tells the guest', async () => {
		const { serial, socket } = await connected()
		serial.resize(132, 43)
		expect(serial.cols).toBe(132)
		expect(serial.rows).toBe(43)
		expect(socket.sent.at(-1)).toBe('1:132:43:')
		expect(() => serial.resize(0, 10)).toThrow(/positive integers/)
	})
})

describe('the screen', () => {
	test('colour and cursor movement come out as plain text', async () => {
		const { serial, socket } = await connected()
		socket.emit('\x1b[1;32mgreen\x1b[0m and \x1b[7mreverse\x1b[m\r\n')
		socket.emit('10%\r50%\r100% done\r\n')
		socket.emit('abcdef\x1b[3D\x1b[KXYZ\r\n')
		socket.emit('one\r\ntwo\x1b[A\x1b[3Dtop')
		const screen = await serial.waitForText('top')
		expect(screen).toBe('green and reverse\n100% done\nabcXYZ\ntop\ntwo')
		expect(screen).not.toContain('\x1b')
	})

	test('a bare newline moves to the start of the next line', async () => {
		const { serial, socket } = await connected()
		socket.emit('first\nsecond')
		expect(await serial.waitForText('second')).toBe('first\nsecond')
	})

	test('a multibyte character split across frames renders once', async () => {
		const { serial, socket } = await connected({}, { splitBytes: 3 })
		socket.emit('café ok')
		expect(await serial.waitForText('ok')).toBe('café ok')
	})

	test('data carries the decoded chunk', async () => {
		const { serial, socket } = await connected()
		const chunks: string[] = []
		serial.on('data', (chunk) => chunks.push(chunk))
		socket.emit('hello')
		await serial.waitForText('hello')
		expect(chunks).toEqual(['hello'])
	})
})

describe('waitForText', () => {
	test('resolves at once when the screen already matches', async () => {
		const { serial, socket } = await connected()
		socket.emit('ready\r\n')
		await serial.waitForText('ready')
		expect(await serial.waitForText(/re.dy/)).toBe('ready')
	})

	test('resolves when later output matches', async () => {
		const { serial, socket } = await connected()
		const waiting = serial.waitForText(/serial-ok-\d+/)
		socket.emit('serial-ok-')
		socket.emit('42\r\n')
		expect(await waiting).toBe('serial-ok-42')
	})

	test('times out with the last screen in the error', async () => {
		const { serial, socket } = await connected()
		socket.emit('Debian GNU/Linux 13 host ttyS0\r\n')
		const error = await serial.waitForText('login:', { timeoutMs: 30 }).catch((caught) => caught)
		expect(error).toBeInstanceOf(PveTimeoutError)
		if (error instanceof PveTimeoutError) {
			expect(error.what).toBe("'login:' on the serial console of guest 101")
			expect(error.waitedMs).toBe(30)
			expect(error.message).toContain('the screen showed:\nDebian GNU/Linux 13 host ttyS0')
		}
	})

	test('rejects when the console closes first', async () => {
		const { serial } = await connected()
		const waiting = serial.waitForText('never')
		serial.close()
		await expect(waiting).rejects.toThrow(PveConsoleError)
	})
})

describe('after sendLine', () => {
	/** A shell that answers `uptime` after a pause and `clear` with a redraw. */
	function shell(): FakePtyOptions {
		return {
			banner: 'root@host:~# ',
			onLine: (line) => {
				if (line === 'clear') return '\x1b[H\x1b[2J\x1b[3Jroot@host:~# '
				return undefined
			},
		}
	}

	test('waitForPrompt resolves only once a prompt follows the output', async () => {
		const { serial, socket } = await connected({}, shell())
		await serial.waitForPrompt()
		serial.sendLine('uptime')
		let settled = false
		const waiting = serial.waitForPrompt({ timeoutMs: 1000 }).then((screen) => {
			settled = true
			return screen
		})
		await serial.waitForText('uptime')
		await Bun.sleep(20)
		expect(settled).toBe(false)
		socket.emit(' 10:00:00 up 3 days\r\nroot@host:~# ')
		expect(await waiting).toBe('root@host:~# uptime\n 10:00:00 up 3 days\nroot@host:~#')
	})

	test('waitForText ignores what was on the screen before the line went out', async () => {
		const { serial, socket } = await connected({}, shell())
		socket.emit('file\r\nroot@host:~# ')
		await serial.waitForText('file')
		serial.sendLine('ls')
		let settled = false
		const waiting = serial.waitForText('file', { timeoutMs: 1000 }).then((screen) => {
			settled = true
			return screen
		})
		await serial.waitForText('ls')
		await Bun.sleep(20)
		expect(settled).toBe(false)
		socket.emit('file\r\nroot@host:~# ')
		expect(await waiting).toBe('file\nroot@host:~# ls\nfile\nroot@host:~#')
	})

	test('a second wait with no new send sees everything since the last one', async () => {
		const { serial, socket } = await connected({}, shell())
		await serial.waitForPrompt()
		serial.sendLine('uptime')
		socket.emit('up\r\nroot@host:~# ')
		await serial.waitForPrompt({ timeoutMs: 1000 })
		expect(await serial.waitForText('up', { timeoutMs: 1000 })).toContain('up')
		expect(await serial.waitForPrompt({ timeoutMs: 1000 })).toBe(
			'root@host:~# uptime\nup\nroot@host:~#',
		)
	})

	test('a prompt drawn at the top after a screen clear counts', async () => {
		const { serial } = await connected({}, shell())
		await serial.waitForPrompt()
		serial.sendLine('clear')
		expect(await serial.waitForPrompt({ timeoutMs: 1000 })).toBe('root@host:~#')
	})
})

describe('waitForPrompt', () => {
	test('watches the line the cursor is on', async () => {
		const { serial, socket } = await connected()
		socket.emit('root@host:~# ls\r\nfile\r\n')
		const waiting = serial.waitForPrompt({ timeoutMs: 500 })
		socket.emit('root@host:~# ')
		expect(await waiting).toBe('root@host:~# ls\nfile\nroot@host:~#')
		socket.emit('\r\nuser@host:~$ ')
		await serial.waitForPrompt({ timeoutMs: 500 })
		socket.emit('\r\n> ')
		await serial.waitForPrompt({ pattern: />\s*$/, timeoutMs: 500 })
	})
})

describe('login', () => {
	/** A getty that takes one user and one password. */
	function getty(user: string, password: string): FakePtyOptions {
		let state: 'login' | 'password' | 'shell' = 'login'
		let typedUser = ''
		return {
			banner: 'Debian GNU/Linux 13 host ttyS0\r\n\r\nhost login: ',
			onLine: (line) => {
				if (state === 'login') {
					if (line === '') return 'host login: '
					typedUser = line
					state = 'password'
					return 'Password: '
				}
				if (state === 'password') {
					if (typedUser === user && line === password) {
						state = 'shell'
						return '\r\nLinux host 6.12.0\r\n\r\nroot@host:~# '
					}
					state = 'login'
					return '\r\nLogin incorrect\r\n\r\nhost login: '
				}
				return 'root@host:~# '
			},
		}
	}

	test('types the user and password at their prompts and resolves at the shell', async () => {
		const { serial, socket } = await connected({}, getty('root', 'secret'))
		await serial.waitForText('login:')
		const screen = await serial.login('root', 'secret', { timeoutMs: 1000 })
		expect(screen.endsWith('root@host:~#')).toBe(true)
		expect(typed(socket)).toEqual(['0:5:root\r', '0:7:secret\r'])
	})

	test('sends Enter first when the cursor is not on a login prompt', async () => {
		const { serial, socket } = await connected({}, getty('root', 'secret'))
		await serial.waitForText('login:')
		socket.emit('\r\nidle')
		await serial.waitForText('idle')
		await serial.login('root', 'secret', { timeoutMs: 1000 })
		expect(typed(socket)[0]).toBe('0:1:\r')
	})

	test('a refused password is a console error', async () => {
		const { serial } = await connected({}, getty('root', 'secret'))
		await serial.waitForText('login:')
		const error = await serial.login('root', 'wrong', { timeoutMs: 1000 }).catch((caught) => caught)
		expect(error).toBeInstanceOf(PveConsoleError)
		expect(String(error)).toContain('refused the login of root')
	})

	test('a prompt that never comes is a timeout carrying the screen', async () => {
		const { serial } = await connected({}, { banner: 'booting...\r\n' })
		await serial.waitForText('booting')
		const error = await serial.login('root', 'secret', { timeoutMs: 30 }).catch((caught) => caught)
		expect(error).toBeInstanceOf(PveTimeoutError)
		expect(String(error)).toContain('a login prompt on the serial console of guest 101')
		expect(String(error)).toContain('booting...')
	})
})

describe('readNew', () => {
	test('returns what rendered since the previous read', async () => {
		const { serial, socket } = await connected()
		socket.emit('one\r\ntwo\r\n')
		await serial.waitForText('two')
		expect(serial.readNew()).toBe('one\ntwo\n')
		expect(serial.readNew()).toBe('')
		socket.emit('login: ')
		await serial.waitForText('login:')
		expect(serial.readNew()).toBe('login: ')
		socket.emit('root\r\n')
		await serial.waitForText('root')
		expect(serial.readNew()).toBe('root\n')
	})

	test('follows lines into the scrollback', async () => {
		const { serial, socket } = await connected({ rows: 2, scrollback: 100 })
		socket.emit('a\r\nb\r\nc\r\nd\r\n')
		await serial.waitForText('d')
		expect(serial.screen()).toBe('d')
		expect(serial.readNew()).toBe('a\nb\nc\nd\n')
	})
})

describe('the connection', () => {
	test('sends a keepalive on its own interval', async () => {
		const { socket } = await connected({ keepaliveMs: 10 })
		await Bun.sleep(35)
		expect(socket.sent.filter((frame) => frame === '2').length).toBeGreaterThanOrEqual(2)
	})

	test('close stops the keepalive, closes the socket and emits close once', async () => {
		const { serial, socket } = await connected({ keepaliveMs: 10 })
		let closes = 0
		serial.on('close', () => closes++)
		serial.close()
		serial.close()
		const sentAtClose = socket.sent.length
		await Bun.sleep(25)
		expect(socket.sent.length).toBe(sentAtClose)
		expect(socket.closes).toBe(1)
		expect(closes).toBe(1)
		expect(serial.connected).toBe(false)
		expect(() => serial.write('ls')).toThrow(PveConsoleError)
	})

	test('the screen stays readable after close', async () => {
		const { serial, socket } = await connected()
		socket.emit('bye\r\n')
		await serial.waitForText('bye')
		serial.close()
		expect(serial.screen()).toBe('bye')
	})

	test('a socket that drops after the handshake emits close and fails the waiters', async () => {
		const { serial, socket } = await connected()
		let closes = 0
		serial.on('close', () => closes++)
		const waiting = serial.waitForText('never')
		socket.close()
		await expect(waiting).rejects.toThrow(/is closed/)
		expect(closes).toBe(1)
	})
})

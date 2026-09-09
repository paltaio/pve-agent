# Consoles

Two consoles, both reachable on an API token, both connecting on the first
call; making the handle sends nothing.

| | `vm.kvm` | `guest.console` |
| --- | --- | --- |
| Type | VNC framebuffer, keyboard and mouse | Serial terminal |
| Guests | QEMU only | QEMU and LXC |
| Reads back | Pixels | Rendered text |
| Needs | A running VM | A `serialN` socket on a VM with something writing to it; a container always has one |

Use the VNC console when nothing inside the guest can talk yet: firmware
setup, a bootloader, an OS installer, a login screen. Use the serial console
when the guest prints to a serial port, which a container always does. Use
`vm.os` or `ct.exec` once an agent or `pct exec` is available; those give you
exit codes.

## VNC

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()
const vm = cluster.vm(100)

await vm.kvm.type('root\n', { cps: 20 })
await vm.kvm.press('ctrl-alt-delete')
await vm.kvm.keyDown('shift')
await vm.kvm.keyUp('shift')
await vm.kvm.move(640, 400)
await vm.kvm.click(640, 400, 'left')
await vm.kvm.scroll(640, 400, 'down', 3)
```

`press` takes a key name or a combination such as `'f2'`, `'enter'`, `'esc'`,
`'ctrl-c'` or `'ctrl-alt-delete'`; every key goes down in the order written
and comes up in reverse. `type` sends one character at a time at `cps`
characters per second, wraps the characters a US keyboard reaches with shift
in a shift press, and sends newline as enter. `keyDown` holds a key until
`keyUp`, `close` or process exit. A pointer coordinate outside the framebuffer
throws `PveConfigError`.

The transport is a WebSocket to the node's `vncproxy` worker. `vncproxy`
spawns the worker and answers with a port, a VNC ticket good for about forty
seconds and a one-time password; the handshake runs under a 15 second
timeout. The proxy call and the socket use the same credential: the login
ticket when the client holds one, the API token otherwise.

### Reading the screen

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()
const vm = cluster.vm(100)

const frame = await vm.kvm.snapshot() // owned copy: { width, height, buffer, seq }
const shot = await vm.kvm.screenshot({ format: 'png' }) // { format, width, height, data, seq }
await Bun.write('screen.png', shot.data)

const jpeg = await vm.kvm.screenshot({ format: 'jpeg', quality: 70, fresh: true })
const part = await vm.kvm.screenshot({ region: { x: 0, y: 0, w: 320, h: 200 } })
console.log(frame.seq, jpeg.seq, part.width)
```

`format` defaults to `jpeg` at quality 85. `fresh` asks the guest for a full
repaint and encodes the frame that answers it, so a stale screen is never
mistaken for the current one. `seq` is the paint counter of the frame.

An idle VM blanks its display and QEMU falls back to a 640x480 surface. Press
a key and wait for the full-size frame before taking a screenshot:

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()
const vm = cluster.vm(100)

await vm.kvm.press('shift')
await vm.kvm.waitForScreen((frame) => frame.width > 640, { timeoutMs: 10_000 })
const shot = await vm.kvm.screenshot({ format: 'png' })
console.log(shot.width, shot.height)
```

### Waiting for a screen

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()
const vm = cluster.vm(100)

const before = await vm.kvm.snapshot()
await vm.kvm.press('enter')

await vm.kvm.waitForScreen({ kind: 'changed', since: before }, { timeoutMs: 30_000 })
await vm.kvm.waitForScreen(
	{ kind: 'color', color: '#e57000', threshold: 0.8, area: 0.001 },
	{ timeoutMs: 120_000 },
)
await vm.kvm.waitForScreen({ kind: 'pixel', x: 10, y: 10, color: [255, 255, 255] })
await vm.kvm.waitForScreen((frame) => frame.width >= 1024, { intervalMs: 500 })
```

Three matchers, all reading the framebuffer directly:

- `pixel`: one pixel is within `threshold` similarity of `color`.
- `color`: at least `area` of `region` (the whole frame by default) is within
  `threshold` of `color`. `area` defaults to 0.5.
- `changed`: at least `area` of `region` differs from the `since` frame.
  `area` defaults to 0.001.

`threshold` is a similarity from 0 to 1; 1 is exact and 0.9, the default,
lets each channel drift about 25 levels. A colour is `#rrggbb` or an
`[r, g, b]` triple. A list of matchers has to match in full, or any one of
them with `{ match: 'any' }`. `waitForScreen` reads the screen every
`intervalMs`, 250 by default, and throws `PveTimeoutError` at `timeoutMs`,
30 seconds by default. It resolves with the frame that matched.

`match()` is the same check run once against the current frame:

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()
const vm = cluster.vm(100)

const result = await vm.kvm.match({ kind: 'color', color: '#000098', area: 0.02 })
console.log(result.matched, result.results)
```

### Firmware drops early keystrokes

Firmware ignores input until it is the thing waiting for it, so a single
press lands too early and nothing happens. Press in a loop until the screen
answers:

```ts
import pve, { PveTimeoutError, type PveVm } from 'pve-agent'

async function pressUntil(vm: PveVm, key: string, color: string, timeoutMs: number) {
	const deadline = Date.now() + timeoutMs
	for (;;) {
		await vm.kvm.press(key)
		try {
			return await vm.kvm.waitForScreen(
				{ kind: 'color', color, area: 0.02 },
				{ timeoutMs: 2000 },
			)
		} catch (error) {
			if (!(error instanceof PveTimeoutError) || Date.now() >= deadline) throw error
		}
	}
}

await using cluster = await pve.connect()
await pressUntil(cluster.vm(100), 'f2', '#000098', 60_000)
```

`examples/install-over-kvm.ts` is a working version.

### Reading pixels yourself

```ts
import pve, { changedFraction, colorRatio, cropFrame, pixelAt, scaleFrame } from 'pve-agent'

await using cluster = await pve.connect()
const vm = cluster.vm(100)

const frame = await vm.kvm.snapshot()
console.log(pixelAt(frame, 10, 10)) // [r, g, b]
console.log(colorRatio(frame, '#000000', { region: { x: 0, y: 0, w: 100, h: 100 } }))
const corner = cropFrame(frame, { x: 0, y: 0, w: 320, h: 200 })
const bigger = scaleFrame(corner, 2)
console.log(changedFraction(frame, await vm.kvm.snapshot()), bigger.width)
```

### The session underneath

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()
const vm = cluster.vm(100)

const session = await vm.kvm.session()
console.log(session.connected, session.updateSeq, session.heldKeys)
session.snapshot()
session.sendKeyEvent(true, 0xff0d)
session.sendPointerEvent(1, 100, 100)
session.sendClipboard('text')
const since = session.requestUpdate()
await session.waitForUpdate(3000, since)
session.on('resize', (width, height) => console.log(width, height))
```

`VncSession` is an `EventEmitter` with `update`, `resize`, `clipboard`,
`bell`, `close` and `error` events.

Coordinates are framebuffer pixels. A guest that changes resolution
invalidates whatever you measured, so take a snapshot after a mode change
before clicking.

`vm.kvm.close()` drops the session; the next call opens a new one.
`cluster.close()` drops every session at once.

## Serial

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()
const vm = cluster.vm(100)
const required = (name: string): string => {
	const value = process.env[name]
	if (!value) throw new Error(`${name} is not set`)
	return value
}

await vm.console.waitForText(/login:/, { timeoutMs: 120_000 })
await vm.console.login('root', required('VM_PASSWORD')) // resolves at a shell prompt
await vm.console.sendLine('cat /etc/os-release')
const screen = await vm.console.waitForPrompt()
console.log(screen)

await vm.console.sendKey('ctrl-c')
await vm.console.write('y')
await vm.console.resize(120, 40)
console.log(await vm.console.readNew()) // text rendered since the previous call
console.log(await vm.console.screen()) // the whole screen
await vm.console.close()
```

Output is fed into a headless xterm emulator, so `screen()` returns the
rendered screen with trailing blank lines removed: what a user would see, not
a byte stream. Redraws and progress bars come out as their final state.

`waitForText` takes a string or a RegExp and matches it against the text
rendered since the last `sendLine`, or against the whole screen when nothing
has been sent yet. `waitForPrompt` tests the line the cursor is on against
`SHELL_PROMPT`, a line ending in `$` or `#`, or against the `pattern` you
pass; after a `sendLine` the prompt has to be one rendered after the line went
out, since the cursor line still ends in the old prompt until the echo comes
back. A guest that redraws the screen from the top, as `clear` does, resets
both to the whole screen. Both waits throw `PveTimeoutError` with the last
screen in the message when the timeout, 30 seconds by default, passes.
`login` waits for the login and password prompts in turn, sends Enter first
when the cursor is not on a login prompt, and throws `PveConsoleError` when
the guest refuses the credentials.

`sendKey` takes `'enter'`, `'tab'`, `'escape'`, `'backspace'`, `'delete'`,
`'insert'`, `'up'`, `'down'`, `'left'`, `'right'`, `'home'`, `'end'`,
`'pageup'`, `'pagedown'`, `'f1'` to `'f12'`, and `'ctrl-a'` to `'ctrl-z'`.

A VM needs a `serialN` socket in its config and something inside writing to
it: `console=ttyS0` on the kernel command line, or a getty on the port. A
getty started by hand stops at the next reboot; enable the unit to keep it.

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()
const vm = cluster.vm(100)

await vm.configure({ serial0: 'socket' }) // takes effect on the next start
await vm.reboot()
await vm.waitForAgent()
await vm.guest.output(['systemctl', 'enable', '--now', 'serial-getty@ttyS0.service'])
```

Name the port and the size when opening the session; the options apply to the
first call only:

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()
const vm = cluster.vm(100)

await vm.console.session({ serial: 'serial1', cols: 120, rows: 40 })
```

A container always has a console, so nothing is needed there:

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()
const ct = cluster.container(110)

await ct.console.sendLine('')
console.log(await ct.console.waitForText(/login:|\$ /))
```

The transport is a WebSocket to the guest's `termproxy` worker. Both consoles
run over the same `vncwebsocket` endpoint; the proxy call decides which
protocol comes back.

## Guest console endpoints and credentials

All four guest console endpoints are reachable on an API token:

```
POST /nodes/{node}/{qemu,lxc}/{vmid}/vncproxy
GET  /nodes/{node}/{qemu,lxc}/{vmid}/vncwebsocket
POST /nodes/{node}/{qemu,lxc}/{vmid}/termproxy
POST /nodes/{node}/{qemu,lxc}/{vmid}/spiceproxy
```

The node-level shell, `POST /nodes/{node}/termproxy`, is gated on a
`root@pam` ticket; see [shell.md](shell.md).

## Sessions

Sessions are keyed by vmid and shared, so two handles for the same guest
reuse one socket, and concurrent callers share one handshake. A failed open
leaves nothing behind, so the next call tries again.

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()
const vm = cluster.vm(100)

await vm.kvm.close() // the VNC session
await vm.console.close() // the serial console
await vm.closeSessions() // both, leaving the guest running
await cluster.closeVncSession(100)
await cluster.closeSerialConsole(100)
```

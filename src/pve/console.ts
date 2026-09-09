/**
 * Keyboard, mouse, screen and serial console for one guest.
 *
 * Both wrappers connect on the first call rather than when the handle is
 * made, and both hand back the session underneath through `session()` for
 * anything they do not cover.
 */

import {
	matchScreen,
	waitForScreen,
	type ScreenMatchOptions,
	type ScreenMatchResult,
	type ScreenMatcher,
	type ScreenPredicate,
	type ScreenWaitOptions,
} from '../console/match.ts'
import { captureScreenshot, type CaptureOptions, type Screenshot } from '../console/screenshot.ts'
import type {
	PromptOptions,
	SerialConsole,
	SerialKey,
	SerialWaitOptions,
} from '../console/terminal.ts'
import type { FramebufferSnapshot, MouseButton, TypeOptions, VncSession } from '../console/vnc.ts'
import type { GuestRef } from '../guest/types.ts'
import type { PveContext, SerialOpenOptions } from './context.ts'

/**
 * The VNC console of a VM: the keyboard and mouse the firmware and the OS
 * see, and the framebuffer they paint. The VM has to be running.
 */
export class VmKvm {
	private readonly context: PveContext
	private readonly ref: Required<GuestRef>

	constructor(context: PveContext, ref: Required<GuestRef>) {
		this.context = context
		this.ref = ref
	}

	/** The VNC session, connecting on the first call. Concurrent callers share one handshake. */
	session(): Promise<VncSession> {
		return this.context.vncSession(this.ref)
	}

	/** Taps a key or a combination such as 'ctrl-alt-delete', 'f2' or 'enter'. */
	async press(combo: string): Promise<void> {
		;(await this.session()).press(combo)
	}

	/** Types text one character at a time. Newline goes out as enter. */
	async type(text: string, options?: TypeOptions): Promise<void> {
		await (await this.session()).type(text, options)
	}

	/** Holds a key down until `keyUp`, `close` or process exit. */
	async keyDown(key: string): Promise<void> {
		;(await this.session()).keyDown(key)
	}

	async keyUp(key: string): Promise<void> {
		;(await this.session()).keyUp(key)
	}

	/** Moves the pointer to a framebuffer coordinate. */
	async move(x: number, y: number): Promise<void> {
		;(await this.session()).move(x, y)
	}

	/** Moves to a point, presses a button there and releases it. */
	async click(x: number, y: number, button?: MouseButton): Promise<void> {
		;(await this.session()).click(x, y, button)
	}

	/** Sends `amount` wheel clicks at a point. */
	async scroll(x: number, y: number, direction: 'up' | 'down', amount?: number): Promise<void> {
		;(await this.session()).scroll(x, y, direction, amount)
	}

	/** An owned copy of the current frame, safe to read across an await. */
	async snapshot(): Promise<FramebufferSnapshot> {
		return (await this.session()).snapshot()
	}

	/** The current frame encoded as JPEG or PNG. `fresh` asks the guest for a repaint first. */
	async screenshot(options?: CaptureOptions): Promise<Screenshot> {
		return captureScreenshot(await this.session(), options)
	}

	/** Runs the matchers against the current frame once. */
	async match(
		matchers: ScreenMatcher | readonly ScreenMatcher[],
		options?: ScreenMatchOptions,
	): Promise<ScreenMatchResult> {
		return matchScreen(await this.snapshot(), matchers, options)
	}

	/**
	 * Reads the screen until it satisfies the predicate or the matchers, and
	 * resolves with the frame that did. Throws PveTimeoutError when the
	 * deadline passes first.
	 */
	async waitForScreen(
		check: ScreenPredicate | ScreenMatcher | readonly ScreenMatcher[],
		options?: ScreenWaitOptions,
	): Promise<FramebufferSnapshot> {
		return waitForScreen(await this.session(), check, options)
	}

	/** Closes the session. The next call opens a new one. */
	close(): Promise<void> {
		return this.context.closeVncSession(this.ref.vmid)
	}
}

/**
 * The serial console of a guest, read back through a headless terminal so
 * `screen()` is what a user would see rather than a byte stream.
 *
 * A VM needs a `serialN` socket in its config and something inside it
 * writing to that port; a container always has one.
 */
export class GuestConsole {
	private readonly context: PveContext
	private readonly ref: Required<GuestRef>

	constructor(context: PveContext, ref: Required<GuestRef>) {
		this.context = context
		this.ref = ref
	}

	/** The console session, connecting on the first call. `options` apply to that first call only. */
	session(options?: SerialOpenOptions): Promise<SerialConsole> {
		return this.context.serialConsole(this.ref, options)
	}

	/** Sends text as typed. */
	async write(text: string): Promise<void> {
		;(await this.session()).write(text)
	}

	/** Sends text followed by Enter. */
	async sendLine(text: string): Promise<void> {
		;(await this.session()).sendLine(text)
	}

	/** Sends a named key such as 'enter', 'escape', 'up' or 'ctrl-c'. */
	async sendKey(key: SerialKey): Promise<void> {
		;(await this.session()).sendKey(key)
	}

	/** The screen as plain text, trailing blank lines removed. */
	async screen(): Promise<string> {
		return (await this.session()).screen()
	}

	/** Text rendered since the previous call, or since the console opened. */
	async readNew(): Promise<string> {
		return (await this.session()).readNew()
	}

	/**
	 * Resolves with the screen once `pattern` matches it. Throws
	 * PveTimeoutError carrying the last screen when the deadline passes.
	 */
	async waitForText(pattern: string | RegExp, options?: SerialWaitOptions): Promise<string> {
		return (await this.session()).waitForText(pattern, options)
	}

	/** Resolves with the screen once the line the cursor is on ends in a shell prompt. */
	async waitForPrompt(options?: PromptOptions): Promise<string> {
		return (await this.session()).waitForPrompt(options)
	}

	/**
	 * Logs in at a getty and resolves with the screen once a shell prompt
	 * shows. Throws PveConsoleError when the guest refuses the credentials.
	 */
	async login(user: string, password: string, options?: PromptOptions): Promise<string> {
		return (await this.session()).login(user, password, options)
	}

	/** Resizes the terminal and tells the guest the new window size. */
	async resize(cols: number, rows: number): Promise<void> {
		;(await this.session()).resize(cols, rows)
	}

	/** Closes the session. The next call opens a new one. */
	close(): Promise<void> {
		return this.context.closeSerialConsole(this.ref.vmid)
	}
}

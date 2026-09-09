import { describe, expect, test } from 'bun:test'
import { inputFrames, KEEPALIVE_FRAME, loginFrame, resizeFrame, sendInput } from './pty.ts'
import type { ConsoleSocket } from './socket.ts'

describe('termproxy frames', () => {
	test('the login frame is user, ticket and a newline', () => {
		expect(loginFrame('root@pam', 'PVEVNC:ABC')).toBe('root@pam:PVEVNC:ABC\n')
	})

	test('an input frame carries the byte length, not the character count', () => {
		expect(inputFrames('ls\n').map(String)).toEqual(['0:3:ls\n'])
		expect(inputFrames('café').map(String)).toEqual(['0:5:café'])
		expect(inputFrames('')).toEqual([])
	})

	test('long input is split into 256 byte frames', () => {
		const frames = inputFrames('x'.repeat(600)).map(String)
		expect(frames).toEqual([
			`0:256:${'x'.repeat(256)}`,
			`0:256:${'x'.repeat(256)}`,
			`0:88:${'x'.repeat(88)}`,
		])
	})

	test('a resize frame is cols then rows with a trailing colon', () => {
		expect(resizeFrame(120, 40)).toBe('1:120:40:')
		expect(KEEPALIVE_FRAME).toBe('2')
	})

	test('sendInput sends every frame in order', () => {
		const sent: string[] = []
		const socket: ConsoleSocket = {
			open: true,
			send: (data) => sent.push(String(data)),
			close: () => undefined,
			onOpen: () => undefined,
			onMessage: () => undefined,
			onError: () => undefined,
			onClose: () => undefined,
		}
		sendInput(socket, 'a'.repeat(256) + 'b')
		expect(sent).toEqual([`0:256:${'a'.repeat(256)}`, '0:1:b'])
	})
})

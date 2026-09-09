import { describe, expect, test } from 'bun:test'
import { spawnProcess } from './spawn.ts'

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)

describe('spawnProcess', () => {
	test('runs a program and collects its output', async () => {
		const result = await spawnProcess({ argv: ['/bin/sh', '-c', 'echo hi'] })
		expect(result.exitCode).toBe(0)
		expect(decode(result.stdout)).toBe('hi\n')
		expect(decode(result.stderr)).toBe('')
		expect(result.timedOut).toBe(false)
	})

	test('keeps stderr separate and reports the exit code', async () => {
		const result = await spawnProcess({
			argv: ['/bin/sh', '-c', 'echo out; echo err >&2; exit 3'],
		})
		expect(result.exitCode).toBe(3)
		expect(decode(result.stdout)).toBe('out\n')
		expect(decode(result.stderr)).toBe('err\n')
	})

	test('feeds input to the program', async () => {
		const result = await spawnProcess({
			argv: ['/bin/sh', '-c', 'cat'],
			input: new TextEncoder().encode('payload'),
		})
		expect(decode(result.stdout)).toBe('payload')
	})

	test('closes stdin when there is no input, so a reader does not hang', async () => {
		const result = await spawnProcess({ argv: ['/bin/sh', '-c', 'cat'], timeoutMs: 5000 })
		expect(result.timedOut).toBe(false)
		expect(decode(result.stdout)).toBe('')
	})

	test('kills a program that outlives its deadline', async () => {
		const started = Date.now()
		const result = await spawnProcess({ argv: ['/bin/sh', '-c', 'sleep 5'], timeoutMs: 50 })
		expect(result.timedOut).toBe(true)
		expect(result.exitCode).not.toBe(0)
		expect(Date.now() - started).toBeLessThan(4000)
	})

	test('rejects when the binary cannot be started', async () => {
		await expect(spawnProcess({ argv: ['/nonexistent/binary'] })).rejects.toThrow()
	})
})

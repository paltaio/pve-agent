import { describe, expect, test } from 'bun:test'
import { PveShellPolicyError } from './errors.ts'
import {
	assertPathSegment,
	assertSafeInteger,
	shHeredoc,
	shJoin,
	shQuote,
	shWrap,
} from './escape.ts'

async function sh(script: string): Promise<{ stdout: string; exitCode: number }> {
	const proc = Bun.spawn({ cmd: ['/bin/sh', '-c', script], stdout: 'pipe', stderr: 'pipe' })
	const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
	return { stdout, exitCode }
}

describe('shQuote', () => {
	test('leaves a plain word alone', () => {
		expect(shQuote('/etc/pve/storage.cfg')).toBe('/etc/pve/storage.cfg')
		expect(shQuote('encryption=aes-256-gcm')).toBe('encryption=aes-256-gcm')
	})

	test('quotes an empty string so it stays one argument', () => {
		expect(shQuote('')).toBe("''")
	})

	test('quotes whitespace and shell metacharacters', () => {
		expect(shQuote('two words')).toBe("'two words'")
		expect(shQuote('a;rm -rf /')).toBe("'a;rm -rf /'")
		expect(shQuote('$(whoami)')).toBe("'$(whoami)'")
	})

	test('closes and reopens the quote around an embedded one', () => {
		expect(shQuote("it's")).toBe(`'it'\\''s'`)
	})

	test('quotes a newline and non-ASCII text', () => {
		expect(shQuote('first\nsecond')).toBe("'first\nsecond'")
		expect(shQuote('ca\u00f1\u00f3n')).toBe("'ca\u00f1\u00f3n'")
	})

	test('leaves a leading dash, so operands still need a -- in front of them', () => {
		expect(shQuote('-oProxyCommand=id')).toBe('-oProxyCommand=id')
		expect(shQuote('--not a flag')).toBe("'--not a flag'")
	})

	test('refuses a NUL byte, which execve truncates the value at', () => {
		expect(() => shQuote('/etc/passwd\0/tmp/decoy')).toThrow(PveShellPolicyError)
	})

	test('a quoted value reaches a shell as one literal argument', async () => {
		const value = `it's $(not) "expanded" \\ here`
		const result = await sh(`printf %s ${shQuote(value)}`)
		expect(result.stdout).toBe(value)
	})
})

describe('shJoin', () => {
	test('quotes each element separately', () => {
		expect(shJoin(['/bin/sh', '-c', 'echo hi'])).toBe("/bin/sh -c 'echo hi'")
	})
})

describe('shHeredoc', () => {
	test('carries the content verbatim and ends it with a newline', async () => {
		const content = "line one $HOME\nline 'two' `x`"
		expect(shHeredoc(content)).toBe(`<<'PVE_EOF'\n${content}\nPVE_EOF`)
		const result = await sh(`cat ${shHeredoc(content)}`)
		expect(result.stdout).toBe(`${content}\n`)
	})

	test('keeps a single trailing newline', () => {
		expect(shHeredoc('a\n')).toBe("<<'PVE_EOF'\na\nPVE_EOF")
		expect(shHeredoc('')).toBe("<<'PVE_EOF'\nPVE_EOF")
	})

	test('picks a terminator no line of the content equals', async () => {
		const content = 'PVE_EOF\nPVE_EOF_1\nrest'
		expect(shHeredoc(content)).toStartWith("<<'PVE_EOF_2'\n")
		const result = await sh(`cat ${shHeredoc(content)}`)
		expect(result.stdout).toBe(`${content}\n`)
	})

	test('refuses a NUL byte', () => {
		expect(() => shHeredoc('a\0b')).toThrow(PveShellPolicyError)
	})
})

describe('shWrap', () => {
	test('returns the command untouched without a context', () => {
		expect(shWrap('zpool status', {})).toBe('zpool status')
	})

	test('changes directory and exports variables before the command', async () => {
		const wrapped = shWrap('printf "%s %s" "$PWD" "$GREETING"', {
			cwd: '/tmp',
			env: { GREETING: "hi there's" },
		})
		expect(wrapped).toBe(
			`cd -- /tmp || exit $?; export GREETING='hi there'\\''s'\nprintf "%s %s" "$PWD" "$GREETING"`,
		)
		expect((await sh(wrapped)).stdout).toBe("/tmp hi there's")
	})

	test('a directory that does not exist stops the command', async () => {
		const result = await sh(shWrap('echo ran', { cwd: '/nonexistent-dir' }))
		expect(result.exitCode).not.toBe(0)
		expect(result.stdout).toBe('')
	})

	test('refuses a variable name the shell would not accept', () => {
		expect(() => shWrap('true', { env: { 'A;rm': 'x' } })).toThrow(PveShellPolicyError)
	})
})

describe('assertSafeInteger', () => {
	test('passes an integer through', () => {
		expect(assertSafeInteger(9060, 'vmid')).toBe(9060)
		expect(assertSafeInteger(0, 'vmid')).toBe(0)
	})

	test('refuses a value that is not a number, whatever the type says', () => {
		expect(() => assertSafeInteger('110; rm -rf /' as unknown as number, 'vmid')).toThrow(
			PveShellPolicyError,
		)
		expect(() => assertSafeInteger(Number.NaN, 'vmid')).toThrow(PveShellPolicyError)
		expect(() => assertSafeInteger(1.5, 'vmid')).toThrow(PveShellPolicyError)
		expect(() => assertSafeInteger(2 ** 60, 'vmid')).toThrow(PveShellPolicyError)
	})
})

describe('assertPathSegment', () => {
	test('passes a file name through', () => {
		expect(assertPathSegment('pveproxy.service', 'unit')).toBe('pveproxy.service')
	})

	test('refuses anything that leaves the directory it is joined to', () => {
		for (const value of [
			'',
			'.',
			'..',
			'../../cron.d/x',
			'sub/unit.service',
			'/etc/passwd',
			'a\0',
		]) {
			expect(() => assertPathSegment(value, 'unit')).toThrow(PveShellPolicyError)
		}
	})
})

/**
 * The key/plaintext pair 0123456789abcdef -> 6e09a37726dd560c is the published
 * vector of the d3des code VNC clients share. The other responses come from
 * `openssl enc -des-ecb -K <key> -nopad -provider legacy -provider default`,
 * keyed by the password bytes with the bits of each byte reversed.
 */

import { describe, expect, test } from 'bun:test'
import { desEncryptBlock, vncDesEncrypt } from './des.ts'

const hex = (s: string): Buffer => Buffer.from(s, 'hex')
const CHALLENGE = hex('000102030405060708090a0b0c0d0e0f')

describe('desEncryptBlock', () => {
	test('matches the standard DES vector', () => {
		expect(desEncryptBlock(hex('0123456789abcdef'), hex('0123456789abcdef')).toString('hex')).toBe(
			'56cc09e7cfdc4cef',
		)
	})

	test('matches the FIPS 81 sample under the key 0e329232ea6d0d73', () => {
		expect(desEncryptBlock(hex('0e329232ea6d0d73'), hex('8787878787878787')).toString('hex')).toBe(
			'0000000000000000',
		)
	})
})

describe('vncDesEncrypt', () => {
	test('matches the published d3des vector on both blocks', () => {
		const password = String.fromCharCode(0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef)
		const challenge = hex('0123456789abcdef0123456789abcdef')
		expect(vncDesEncrypt(password, challenge).toString('hex')).toBe(
			'6e09a37726dd560c6e09a37726dd560c',
		)
	})

	test('encrypts a 16-byte challenge under an 8-character password', () => {
		expect(vncDesEncrypt('pve-test', CHALLENGE).toString('hex')).toBe(
			'df7e53aef919660878b0a5d66420a65b',
		)
	})

	test('truncates a password longer than 8 bytes', () => {
		expect(vncDesEncrypt('0123456789', CHALLENGE).toString('hex')).toBe(
			'e78701495117e1afd62fb5d65bb98b20',
		)
		expect(vncDesEncrypt('0123456789', CHALLENGE)).toEqual(vncDesEncrypt('01234567', CHALLENGE))
	})

	test('pads a short password with zero bytes', () => {
		expect(vncDesEncrypt('abc', CHALLENGE).toString('hex')).toBe('9c22b4f2088c3465a1562c4b9d6edb04')
		expect(vncDesEncrypt('abc', CHALLENGE)).toEqual(
			vncDesEncrypt('abc' + '\0'.repeat(5), CHALLENGE),
		)
	})

	test('encrypts under an all-zero key when the password is empty', () => {
		expect(vncDesEncrypt('', Buffer.alloc(16)).toString('hex')).toBe(
			'8ca64de9c1b123a78ca64de9c1b123a7',
		)
	})

	test('treats the two challenge blocks independently', () => {
		const response = vncDesEncrypt('secret', CHALLENGE)
		expect(response.toString('hex')).toBe('ee22539f33a5983ec12f9c2edbc995dd')

		const zeroTail = Buffer.concat([CHALLENGE.subarray(0, 8), Buffer.alloc(8)])
		expect(vncDesEncrypt('secret', zeroTail).subarray(0, 8)).toEqual(response.subarray(0, 8))
	})
})

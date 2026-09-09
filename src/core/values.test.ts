import { describe, expect, test } from 'bun:test'
import {
	isRecord,
	parseBoolean,
	parseTagList,
	stringList,
	toBoolean,
	toOptionalBoolean,
	toOptionalInteger,
	toOptionalNumber,
	toOptionalString,
} from './values.ts'

describe('parseBoolean', () => {
	test('takes every spelling PVE takes', () => {
		expect(['1', 'on', 'yes', 'TRUE'].map(parseBoolean)).toEqual([true, true, true, true])
		expect(['0', 'off', 'no', 'False'].map(parseBoolean)).toEqual([false, false, false, false])
	})

	test('answers undefined to anything else', () => {
		expect(parseBoolean('maybe')).toBeUndefined()
		expect(parseBoolean('')).toBeUndefined()
		expect(parseBoolean('2')).toBeUndefined()
		expect(parseBoolean(' 1')).toBeUndefined()
	})
})

describe('toOptionalBoolean', () => {
	test('reads numbers, strings and booleans', () => {
		expect(toOptionalBoolean(true)).toBe(true)
		expect(toOptionalBoolean(false)).toBe(false)
		expect(toOptionalBoolean(1)).toBe(true)
		expect(toOptionalBoolean(0)).toBe(false)
		expect(toOptionalBoolean(2)).toBe(true)
		expect(toOptionalBoolean('1')).toBe(true)
		expect(toOptionalBoolean('0')).toBe(false)
		expect(toOptionalBoolean('yes')).toBe(true)
		expect(toOptionalBoolean('off')).toBe(false)
	})

	test('says nothing for absent or unreadable values', () => {
		expect(toOptionalBoolean(undefined)).toBeUndefined()
		expect(toOptionalBoolean(null)).toBeUndefined()
		expect(toOptionalBoolean('')).toBeUndefined()
		expect(toOptionalBoolean('maybe')).toBeUndefined()
		expect(toOptionalBoolean(Number.NaN)).toBeUndefined()
		expect(toOptionalBoolean(Number.POSITIVE_INFINITY)).toBeUndefined()
		expect(toOptionalBoolean({})).toBeUndefined()
	})
})

describe('toBoolean', () => {
	test('folds absent or unreadable to false', () => {
		expect(toBoolean(1)).toBe(true)
		expect(toBoolean('on')).toBe(true)
		expect(toBoolean('0')).toBe(false)
		expect(toBoolean(undefined)).toBe(false)
		expect(toBoolean(null)).toBe(false)
		expect(toBoolean('maybe')).toBe(false)
	})
})

describe('toOptionalNumber', () => {
	test('reads finite numbers and numeric strings', () => {
		expect(toOptionalNumber(42)).toBe(42)
		expect(toOptionalNumber(0)).toBe(0)
		expect(toOptionalNumber(-1.5)).toBe(-1.5)
		expect(toOptionalNumber('42')).toBe(42)
		expect(toOptionalNumber('-0.25')).toBe(-0.25)
	})

	test('takes only a plain decimal numeral', () => {
		for (const text of ['1e3', '0x10', '  ', ' 7', '7 ', '+7', '.5', '7.', 'Infinity']) {
			expect(toOptionalNumber(text)).toBeUndefined()
		}
	})

	test('says nothing for absent or unreadable values', () => {
		expect(toOptionalNumber(undefined)).toBeUndefined()
		expect(toOptionalNumber(null)).toBeUndefined()
		expect(toOptionalNumber('')).toBeUndefined()
		expect(toOptionalNumber('abc')).toBeUndefined()
		expect(toOptionalNumber(Number.NaN)).toBeUndefined()
		expect(toOptionalNumber(true)).toBeUndefined()
	})
})

describe('toOptionalInteger', () => {
	test('reads whole numbers only', () => {
		expect(toOptionalInteger('16')).toBe(16)
		expect(toOptionalInteger(-3)).toBe(-3)
		expect(toOptionalInteger('1.5')).toBeUndefined()
		expect(toOptionalInteger(2.5)).toBeUndefined()
		expect(toOptionalInteger('0x10')).toBeUndefined()
	})
})

describe('toOptionalString', () => {
	test('keeps non-empty strings and spells numbers out', () => {
		expect(toOptionalString('pve')).toBe('pve')
		expect(toOptionalString(100)).toBe('100')
		expect(toOptionalString(0)).toBe('0')
	})

	test('says nothing for empty, absent or other values', () => {
		expect(toOptionalString('')).toBeUndefined()
		expect(toOptionalString(undefined)).toBeUndefined()
		expect(toOptionalString(null)).toBeUndefined()
		expect(toOptionalString(true)).toBeUndefined()
		expect(toOptionalString(['a'])).toBeUndefined()
	})
})

describe('parseTagList', () => {
	test('splits on semicolons and commas', () => {
		expect(parseTagList('web;prod')).toEqual(['web', 'prod'])
		expect(parseTagList('web,prod')).toEqual(['web', 'prod'])
		expect(parseTagList('web; prod, db')).toEqual(['web', 'prod', 'db'])
		expect(parseTagList('solo')).toEqual(['solo'])
	})

	test('drops empty entries and answers an empty list otherwise', () => {
		expect(parseTagList('web;;prod;')).toEqual(['web', 'prod'])
		expect(parseTagList('')).toEqual([])
		expect(parseTagList(undefined)).toEqual([])
		expect(parseTagList(null)).toEqual([])
		expect(parseTagList(3)).toEqual([])
	})
})

describe('isRecord', () => {
	test('accepts a plain object and nothing else', () => {
		expect(isRecord({})).toBe(true)
		expect(isRecord({ a: 1 })).toBe(true)
		expect(isRecord([])).toBe(false)
		expect(isRecord(null)).toBe(false)
		expect(isRecord('x')).toBe(false)
	})
})

describe('stringList', () => {
	test('keeps the strings of an array and splits a delimited string', () => {
		expect(stringList(['a', 'b', 3, null])).toEqual(['a', 'b'])
		expect(stringList('a;b,c')).toEqual(['a', 'b', 'c'])
		expect(stringList(undefined)).toEqual([])
		expect(stringList(7)).toEqual([])
	})
})

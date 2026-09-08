/**
 * Reading the values PVE puts in a JSON answer.
 *
 * The API is generated from Perl, so a flag arrives as 0 or 1, as the string
 * '0' or '1', occasionally as a real boolean, and an unset one is absent. A
 * tag list arrives as one delimited string. Every module that turns a row into
 * a typed object reads it through the helpers here, so the same field has the
 * same type wherever it appears.
 */

/**
 * PVE truthiness: 1, on, yes and true against 0, off, no and false, in any
 * letter case. Anything else is undefined.
 */
export function parseBoolean(value: string): boolean | undefined {
	if (/^(1|on|yes|true)$/i.test(value)) return true
	if (/^(0|off|no|false)$/i.test(value)) return false
	return undefined
}

/** A PVE value read as a boolean, or undefined when it says nothing. */
export function toOptionalBoolean(value: unknown): boolean | undefined {
	if (typeof value === 'boolean') return value
	if (typeof value === 'number') return Number.isFinite(value) ? value !== 0 : undefined
	if (typeof value === 'string') return parseBoolean(value)
	return undefined
}

/** The same, with an absent or unreadable value folded to false. */
export function toBoolean(value: unknown): boolean {
	return toOptionalBoolean(value) ?? false
}

export function toOptionalNumber(value: unknown): number | undefined {
	if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
	if (typeof value === 'string' && value.length > 0) {
		const parsed = Number(value)
		return Number.isFinite(parsed) ? parsed : undefined
	}
	return undefined
}

export function toOptionalString(value: unknown): string | undefined {
	if (typeof value === 'string') return value.length > 0 ? value : undefined
	if (typeof value === 'number') return String(value)
	return undefined
}

const TAG_SEPARATOR = /[;,]\s*/

/** PVE joins tags with semicolons, and older configs used commas. */
export function parseTagList(value: unknown): string[] {
	if (typeof value !== 'string' || value.length === 0) return []
	return value.split(TAG_SEPARATOR).filter((tag) => tag.length > 0)
}

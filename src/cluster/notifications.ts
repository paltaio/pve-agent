/**
 * Notification targets and matchers.
 *
 * A target is somewhere to send to: a gotify server, sendmail, an SMTP relay,
 * or a webhook. A matcher decides which events reach which targets. The
 * built-in `mail-to-root` target has no config entry and cannot be edited or
 * removed through these endpoints, but it does show up in `listTargets`.
 */

import type { PveClient } from '../core/client.ts'
import { toOptionalBoolean, toOptionalString } from '../core/values.ts'
import type {
	ClusterNotificationsEndpointsGotifyPostParams,
	ClusterNotificationsEndpointsGotifyPutParams,
	ClusterNotificationsEndpointsSendmailPostParams,
	ClusterNotificationsEndpointsSendmailPutParams,
	ClusterNotificationsEndpointsSmtpPostParams,
	ClusterNotificationsEndpointsSmtpPutParams,
	ClusterNotificationsEndpointsWebhookPostParams,
	ClusterNotificationsEndpointsWebhookPutParams,
	ClusterNotificationsMatchersPostParams,
	ClusterNotificationsMatchersPutParams,
} from '../generated/types.ts'

export type NotificationTargetOrigin = 'builtin' | 'modified-builtin' | 'user-created'

const TARGET_ORIGINS: readonly NotificationTargetOrigin[] = [
	'builtin',
	'modified-builtin',
	'user-created',
]

export interface NotificationTarget {
	name: string
	type: string
	comment: string | undefined
	disable: boolean | undefined
	/** `builtin` targets ship with PVE and are not stored in the config file. */
	origin: NotificationTargetOrigin | undefined
	raw: Readonly<Record<string, unknown>>
}

function normalizeTarget(raw: Record<string, unknown>): NotificationTarget {
	return {
		name: String(raw['name'] ?? ''),
		type: String(raw['type'] ?? ''),
		comment: toOptionalString(raw['comment']),
		disable: toOptionalBoolean(raw['disable']),
		origin: TARGET_ORIGINS.find((origin) => origin === raw['origin']),
		raw,
	}
}

export interface NotificationMatcher {
	name: string
	comment: string | undefined
	disable: boolean | undefined
	matchSeverity: string[]
	matchField: string[]
	matchCalendar: string[]
	mode: 'all' | 'any' | undefined
	/** Targets a matching notification is sent to. */
	target: string[]
	/** Send when the rules do not match instead of when they do. */
	invertMatch: boolean | undefined
	raw: Readonly<Record<string, unknown>>
}

function stringList(value: unknown): string[] {
	return Array.isArray(value) ? value.map(String) : []
}

function normalizeMatcher(raw: Record<string, unknown>): NotificationMatcher {
	const mode = raw['mode']
	return {
		name: String(raw['name'] ?? ''),
		comment: toOptionalString(raw['comment']),
		disable: toOptionalBoolean(raw['disable']),
		matchSeverity: stringList(raw['match-severity']),
		matchField: stringList(raw['match-field']),
		matchCalendar: stringList(raw['match-calendar']),
		mode: mode === 'all' || mode === 'any' ? mode : undefined,
		target: stringList(raw['target']),
		invertMatch: toOptionalBoolean(raw['invert-match']),
		raw,
	}
}

export type NotificationEndpointKind = 'gotify' | 'sendmail' | 'smtp' | 'webhook'

/** CRUD over one endpoint kind. */
export class NotificationEndpointApi<TCreate extends object, TUpdate extends object> {
	readonly client: PveClient
	readonly kind: NotificationEndpointKind

	constructor(client: PveClient, kind: NotificationEndpointKind) {
		this.client = client
		this.kind = kind
	}

	/** Endpoints of this kind. Token tier. */
	async list(): Promise<NotificationTarget[]> {
		const rows = await this.client.get<Record<string, unknown>[]>(
			`/cluster/notifications/endpoints/${this.kind}`,
		)
		return rows.map(normalizeTarget)
	}

	async get(name: string): Promise<NotificationTarget> {
		return normalizeTarget(
			await this.client.get<Record<string, unknown>>(
				`/cluster/notifications/endpoints/${this.kind}/${encodeURIComponent(name)}`,
			),
		)
	}

	/** Create an endpoint. Returns nothing. */
	async create(params: TCreate): Promise<void> {
		await this.client.post<null>(`/cluster/notifications/endpoints/${this.kind}`, params)
	}

	/** Change an endpoint. `delete` unsets keys. Returns nothing. */
	async update(name: string, params: TUpdate): Promise<void> {
		await this.client.put<null>(
			`/cluster/notifications/endpoints/${this.kind}/${encodeURIComponent(name)}`,
			params,
		)
	}

	/** Delete an endpoint. A matcher still naming it stops delivering. */
	async delete(name: string): Promise<void> {
		await this.client.delete<null>(
			`/cluster/notifications/endpoints/${this.kind}/${encodeURIComponent(name)}`,
		)
	}
}

export class ClusterNotificationsApi {
	readonly client: PveClient
	readonly gotify: NotificationEndpointApi<
		ClusterNotificationsEndpointsGotifyPostParams,
		ClusterNotificationsEndpointsGotifyPutParams
	>
	readonly sendmail: NotificationEndpointApi<
		ClusterNotificationsEndpointsSendmailPostParams,
		ClusterNotificationsEndpointsSendmailPutParams
	>
	readonly smtp: NotificationEndpointApi<
		ClusterNotificationsEndpointsSmtpPostParams,
		ClusterNotificationsEndpointsSmtpPutParams
	>
	readonly webhook: NotificationEndpointApi<
		ClusterNotificationsEndpointsWebhookPostParams,
		ClusterNotificationsEndpointsWebhookPutParams
	>

	constructor(client: PveClient) {
		this.client = client
		this.gotify = new NotificationEndpointApi(client, 'gotify')
		this.sendmail = new NotificationEndpointApi(client, 'sendmail')
		this.smtp = new NotificationEndpointApi(client, 'smtp')
		this.webhook = new NotificationEndpointApi(client, 'webhook')
	}

	/** Every target of every kind, including the built-in ones. Token tier. */
	async listTargets(): Promise<NotificationTarget[]> {
		const rows = await this.client.get<Record<string, unknown>[]>('/cluster/notifications/targets')
		return rows.map(normalizeTarget)
	}

	/**
	 * Send a test notification through one target. Use it to check credentials
	 * without waiting for a real event. Returns nothing.
	 */
	async testTarget(name: string): Promise<void> {
		await this.client.post<null>(`/cluster/notifications/targets/${encodeURIComponent(name)}/test`)
	}

	/** Matchers, in the order they are evaluated. Token tier. */
	async listMatchers(): Promise<NotificationMatcher[]> {
		const rows = await this.client.get<Record<string, unknown>[]>('/cluster/notifications/matchers')
		return rows.map(normalizeMatcher)
	}

	async getMatcher(name: string): Promise<NotificationMatcher> {
		return normalizeMatcher(
			await this.client.get<Record<string, unknown>>(
				`/cluster/notifications/matchers/${encodeURIComponent(name)}`,
			),
		)
	}

	/**
	 * Create a matcher. `match-field`, `match-severity` and `match-calendar` are
	 * repeated parameters, so pass arrays. `mode` decides whether all or any of
	 * them must hold. Returns nothing.
	 */
	async createMatcher(params: ClusterNotificationsMatchersPostParams): Promise<void> {
		await this.client.post<null>('/cluster/notifications/matchers', params)
	}

	/** Change a matcher. `delete` unsets keys. Returns nothing. */
	async updateMatcher(name: string, params: ClusterNotificationsMatchersPutParams): Promise<void> {
		await this.client.put<null>(
			`/cluster/notifications/matchers/${encodeURIComponent(name)}`,
			params,
		)
	}

	async deleteMatcher(name: string): Promise<void> {
		await this.client.delete<null>(`/cluster/notifications/matchers/${encodeURIComponent(name)}`)
	}

	/** Field names `match-field` accepts. Token tier. */
	async matcherFields(): Promise<Record<string, unknown>[]> {
		return this.client.get<Record<string, unknown>[]>('/cluster/notifications/matcher-fields')
	}

	/** Known values for those fields, for building a `match-field` entry. Token tier. */
	async matcherFieldValues(): Promise<Record<string, unknown>[]> {
		return this.client.get<Record<string, unknown>[]>('/cluster/notifications/matcher-field-values')
	}
}

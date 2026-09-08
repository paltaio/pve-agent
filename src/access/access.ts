/**
 * Users, groups, roles, ACLs, realms, API tokens, two-factor and tickets.
 *
 * PVE permissions are path based. A role is a named set of privileges; an ACL
 * entry grants a role on a path to a user, group or token, and propagates down
 * the tree unless `propagate` is turned off. `/` is the root, `/nodes/<node>`,
 * `/vms/<vmid>`, `/storage/<id>` and `/pool/<id>` are the usual subtrees.
 *
 * An API token has its own identity, `user@realm!name`. With `privsep` on,
 * the default, the token gets only the privileges granted to the token id
 * itself, so a fresh token can do nothing until an ACL names it. With
 * `privsep` off it inherits the user's privileges.
 *
 * `POST /access/ticket`, `PUT /access/password` and the TFA writes are
 * registered with allowtoken 0: an API token may not call them, and the client
 * runs them on the login ticket.
 */

import type { CredentialInput } from '../core/auth.ts'
import { PveClient, type RequestTrace } from '../core/client.ts'
import {
	parseTagList,
	toOptionalBoolean,
	toOptionalNumber,
	toOptionalString,
} from '../core/values.ts'
import type {
	AccessAclPutParams,
	AccessDomainsPostParams,
	AccessDomainsPutParams,
	AccessDomainsSyncPostParams,
	AccessGroupsPostParams,
	AccessGroupsPutParams,
	AccessOpenidAuthUrlPostParams,
	AccessOpenidLoginPostParams,
	AccessPasswordPutParams,
	AccessPermissionsGetParams,
	AccessRolesPostParams,
	AccessRolesPutParams,
	AccessTfaDeleteParams,
	AccessTfaPostParams,
	AccessTfaPutParams,
	AccessTicketPostParams,
	AccessUsersGetParams,
	AccessUsersPostParams,
	AccessUsersPutParams,
	AccessUsersTfaGetParams,
	AccessUsersTokenPostParams,
	AccessUsersTokenPutParams,
	AccessVncticketPostParams,
} from '../generated/types.ts'

type Raw = Readonly<Record<string, unknown>>

export interface PveUser {
	userid: string
	/** False blocks logins without deleting anything. */
	enable: boolean | undefined
	/** Epoch seconds the account expires. 0 means never. */
	expire: number | undefined
	email: string | undefined
	firstname: string | undefined
	lastname: string | undefined
	comment: string | undefined
	/** Group ids the user belongs to. */
	groups: string[]
	keys: string | undefined
	realmType: string | undefined
	/** Epoch seconds until which second factors are locked after repeated failures. */
	tfaLockedUntil: number | undefined
	totpLocked: boolean | undefined
	/** Filled by `getUser` and by `listUsers` with `full`. */
	tokens: ApiToken[] | undefined
	raw: Raw
}

export interface PveGroup {
	groupid: string
	comment: string | undefined
	/** Member userids. */
	members: string[]
	raw: Raw
}

export interface PveRole {
	roleid: string
	privs: string[]
	/** True for the roles PVE ships, which cannot be changed. */
	special: boolean | undefined
	raw: Raw
}

export interface AclEntry {
	path: string
	type: 'user' | 'group' | 'token'
	ugid: string
	roleid: string
	/** The grant extends to everything below `path`. */
	propagate: boolean | undefined
	raw: Raw
}

export interface ApiToken {
	tokenid: string
	comment: string | undefined
	/** Epoch seconds the token expires. 0 means never. */
	expire: number | undefined
	/**
	 * The token holds only the privileges granted to the token id itself.
	 * With it off the token inherits the user's.
	 */
	privsep: boolean | undefined
	raw: Raw
}

/** The one time the secret is readable. Store it; it cannot be read back. */
export interface ApiTokenSecret {
	/** The id to authenticate with, `user@realm!name`. */
	fullTokenId: string
	value: string
	info: ApiToken
	raw: Raw
}

/** One realm as the list call returns it. */
export interface AuthRealm extends Record<string, unknown> {
	realm: string
	type: string
	comment?: string
	tfa?: string
}

export interface TfaEntry {
	id: string
	type: string
	description: string | undefined
	enable: boolean | undefined
	/** Epoch seconds the entry was registered. */
	created: number | undefined
	raw: Raw
}

/** One user's second factors, as `listTfa` returns them. */
export interface UserTfa {
	userid: string
	entries: TfaEntry[]
	/** Epoch seconds until which second factors are locked after repeated failures. */
	tfaLockedUntil: number | undefined
	totpLocked: boolean | undefined
	raw: Raw
}

export interface TfaAdded {
	id: string
	/** Set for a `u2f` or `webauthn` entry; send it back with `value` to finish. */
	challenge: string | undefined
	/** The codes of a new `recovery` entry, shown this once. */
	recovery: string[] | undefined
	raw: Raw
}

/** Path to a map of privilege to propagate flag, 1 when the grant propagates. */
export type EffectivePermissions = Record<string, Record<string, number>>

export interface AuthTicket {
	ticket: string
	username: string
	csrfToken: string | undefined
	clustername: string | undefined
	/** True when the realm wants a second factor before the ticket is valid. */
	needTfa: boolean | undefined
	/** Send this back with `otp` to finish a two-factor login. */
	tfaChallenge: string | undefined
	raw: Raw
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function record(value: unknown): Raw {
	return isRecord(value) ? value : {}
}

function records(value: unknown): Raw[] {
	const items: unknown[] = Array.isArray(value) ? value : []
	return items.filter(isRecord)
}

/** A list PVE sends either as an array or as one delimited string. */
function stringList(value: unknown): string[] {
	if (!Array.isArray(value)) return parseTagList(value)
	const items: unknown[] = value
	return items.filter((item): item is string => typeof item === 'string')
}

function normalizeToken(raw: Raw, tokenid = ''): ApiToken {
	return {
		tokenid: toOptionalString(raw['tokenid']) ?? tokenid,
		comment: toOptionalString(raw['comment']),
		expire: toOptionalNumber(raw['expire']),
		privsep: toOptionalBoolean(raw['privsep']),
		raw,
	}
}

function normalizeTokenSecret(raw: Raw, tokenid: string): ApiTokenSecret {
	return {
		fullTokenId: toOptionalString(raw['full-tokenid']) ?? '',
		value: toOptionalString(raw['value']) ?? '',
		info: normalizeToken(record(raw['info']), tokenid),
		raw,
	}
}

/**
 * The list call sends a user's tokens as an array of rows; the single-user
 * call sends a map keyed by token id.
 */
function normalizeUserTokens(value: unknown): ApiToken[] | undefined {
	if (Array.isArray(value)) return records(value).map((row) => normalizeToken(row))
	if (isRecord(value)) {
		return Object.entries(value).map(([tokenid, row]) => normalizeToken(record(row), tokenid))
	}
	return undefined
}

function normalizeUser(raw: Raw, userid = ''): PveUser {
	return {
		userid: toOptionalString(raw['userid']) ?? userid,
		enable: toOptionalBoolean(raw['enable']),
		expire: toOptionalNumber(raw['expire']),
		email: toOptionalString(raw['email']),
		firstname: toOptionalString(raw['firstname']),
		lastname: toOptionalString(raw['lastname']),
		comment: toOptionalString(raw['comment']),
		groups: stringList(raw['groups']),
		keys: toOptionalString(raw['keys']),
		realmType: toOptionalString(raw['realm-type']),
		tfaLockedUntil: toOptionalNumber(raw['tfa-locked-until']),
		totpLocked: toOptionalBoolean(raw['totp-locked']),
		tokens: normalizeUserTokens(raw['tokens']),
		raw,
	}
}

/** The list call names members under `users`; the single-group call under `members`. */
function normalizeGroup(raw: Raw, groupid = ''): PveGroup {
	return {
		groupid: toOptionalString(raw['groupid']) ?? groupid,
		comment: toOptionalString(raw['comment']),
		members: stringList(raw['members'] ?? raw['users']),
		raw,
	}
}

function normalizeRole(raw: Raw): PveRole {
	return {
		roleid: toOptionalString(raw['roleid']) ?? '',
		privs: stringList(raw['privs']),
		special: toOptionalBoolean(raw['special']),
		raw,
	}
}

function normalizeAcl(raw: Raw): AclEntry {
	const type = raw['type']
	return {
		path: toOptionalString(raw['path']) ?? '',
		type: type === 'group' || type === 'token' ? type : 'user',
		ugid: toOptionalString(raw['ugid']) ?? '',
		roleid: toOptionalString(raw['roleid']) ?? '',
		propagate: toOptionalBoolean(raw['propagate']),
		raw,
	}
}

function normalizeTfa(raw: Raw): TfaEntry {
	return {
		id: toOptionalString(raw['id']) ?? '',
		type: toOptionalString(raw['type']) ?? '',
		description: toOptionalString(raw['description']),
		enable: toOptionalBoolean(raw['enable']),
		created: toOptionalNumber(raw['created']),
		raw,
	}
}

function normalizeUserTfa(raw: Raw): UserTfa {
	return {
		userid: toOptionalString(raw['userid']) ?? '',
		entries: records(raw['entries']).map(normalizeTfa),
		tfaLockedUntil: toOptionalNumber(raw['tfa-locked-until']),
		totpLocked: toOptionalBoolean(raw['totp-locked']),
		raw,
	}
}

function normalizeTfaAdded(raw: Raw): TfaAdded {
	return {
		id: toOptionalString(raw['id']) ?? '',
		challenge: toOptionalString(raw['challenge']),
		recovery: Array.isArray(raw['recovery']) ? stringList(raw['recovery']) : undefined,
		raw,
	}
}

function normalizeTicket(raw: Raw): AuthTicket {
	return {
		ticket: toOptionalString(raw['ticket']) ?? '',
		username: toOptionalString(raw['username']) ?? '',
		csrfToken: toOptionalString(raw['CSRFPreventionToken']),
		clustername: toOptionalString(raw['clustername']),
		needTfa: toOptionalBoolean(raw['NeedTFA']),
		tfaChallenge: toOptionalString(raw['tfa-challenge']),
		raw,
	}
}

function userPath(userid: string, suffix = ''): string {
	return `/access/users/${encodeURIComponent(userid)}${suffix}`
}

function tokenPath(userid: string, tokenid: string): string {
	return userPath(userid, `/token/${encodeURIComponent(tokenid)}`)
}

function tfaPath(userid: string, id?: string): string {
	const base = `/access/tfa/${encodeURIComponent(userid)}`
	return id === undefined ? base : `${base}/${encodeURIComponent(id)}`
}

export interface AccessApiOptions {
	timeoutMs?: number
	onRequest?: (trace: RequestTrace) => void
}

export class AccessApi {
	readonly client: PveClient

	constructor(client: PveClient) {
		this.client = client
	}

	/** Build a client from the environment and wrap it. Call `close` when done. */
	static fromEnv(input: CredentialInput & AccessApiOptions = {}): AccessApi {
		return new AccessApi(PveClient.fromEnv(input))
	}

	/**
	 * Users. `full: true` also returns each user's groups and tokens,
	 * `enabled` filters on the enable flag.
	 */
	async listUsers(options?: AccessUsersGetParams): Promise<PveUser[]> {
		return records(await this.client.get<unknown>('/access/users', options)).map((row) =>
			normalizeUser(row),
		)
	}

	/** One user with its groups and tokens. */
	async getUser(userid: string): Promise<PveUser> {
		return normalizeUser(record(await this.client.get<unknown>(userPath(userid))), userid)
	}

	/**
	 * Create a user. `userid` carries the realm, `alice@pve`. A user in the
	 * `pve` realm can be given a `password` here; a `pam` user's password
	 * belongs to the node. Creating the user grants nothing: add an ACL.
	 */
	async createUser(params: AccessUsersPostParams): Promise<void> {
		await this.client.post<null>('/access/users', params)
	}

	/**
	 * Change a user. `groups` replaces the membership list unless `append` is
	 * set. `enable: false` blocks logins without deleting anything.
	 */
	async updateUser(userid: string, params: AccessUsersPutParams): Promise<void> {
		await this.client.put<null>(userPath(userid), params)
	}

	/** Delete a user, its tokens and its ACL entries. */
	async deleteUser(userid: string): Promise<void> {
		await this.client.delete<null>(userPath(userid))
	}

	/** API tokens of one user, without their secrets. */
	async listTokens(userid: string): Promise<ApiToken[]> {
		return records(await this.client.get<unknown>(userPath(userid, '/token'))).map((row) =>
			normalizeToken(row),
		)
	}

	async getToken(userid: string, tokenid: string): Promise<ApiToken> {
		return normalizeToken(
			record(await this.client.get<unknown>(tokenPath(userid, tokenid))),
			tokenid,
		)
	}

	/**
	 * Create an API token and return its secret. The secret is shown once and
	 * cannot be read back, so store `value` from the result.
	 *
	 * `privsep` defaults to on, which means the token starts with no privileges
	 * whatever the user has: grant it a role on a path with `setAcl`, naming
	 * the full `user@realm!name` in `tokens`.
	 */
	async createToken(
		userid: string,
		tokenid: string,
		params?: AccessUsersTokenPostParams,
	): Promise<ApiTokenSecret> {
		return normalizeTokenSecret(
			record(await this.client.post<unknown>(tokenPath(userid, tokenid), params)),
			tokenid,
		)
	}

	/** Change a token's comment, expiry or privilege separation. */
	async updateToken(
		userid: string,
		tokenid: string,
		params: Omit<AccessUsersTokenPutParams, 'regenerate'>,
	): Promise<ApiToken> {
		return normalizeToken(
			record(await this.client.put<unknown>(tokenPath(userid, tokenid), params)),
			tokenid,
		)
	}

	/**
	 * Issue a new secret for a token. The old secret stops working at once.
	 * Other settings passed alongside are applied in the same call.
	 */
	async regenerateToken(
		userid: string,
		tokenid: string,
		params?: Omit<AccessUsersTokenPutParams, 'regenerate'>,
	): Promise<ApiTokenSecret> {
		return normalizeTokenSecret(
			record(
				await this.client.put<unknown>(tokenPath(userid, tokenid), {
					...params,
					regenerate: true,
				}),
			),
			tokenid,
		)
	}

	/** Delete an API token. Anything using it stops working at once. */
	async deleteToken(userid: string, tokenid: string): Promise<void> {
		await this.client.delete<null>(tokenPath(userid, tokenid))
	}

	async listGroups(): Promise<PveGroup[]> {
		return records(await this.client.get<unknown>('/access/groups')).map((row) =>
			normalizeGroup(row),
		)
	}

	async getGroup(groupid: string): Promise<PveGroup> {
		return normalizeGroup(
			record(await this.client.get<unknown>(`/access/groups/${encodeURIComponent(groupid)}`)),
			groupid,
		)
	}

	/** Create a group. Membership is set on the user, not here. */
	async createGroup(params: AccessGroupsPostParams): Promise<void> {
		await this.client.post<null>('/access/groups', params)
	}

	async updateGroup(groupid: string, params: AccessGroupsPutParams): Promise<void> {
		await this.client.put<null>(`/access/groups/${encodeURIComponent(groupid)}`, params)
	}

	/** Delete a group and the ACL entries naming it. */
	async deleteGroup(groupid: string): Promise<void> {
		await this.client.delete<null>(`/access/groups/${encodeURIComponent(groupid)}`)
	}

	/** Roles, built-in and custom. */
	async listRoles(): Promise<PveRole[]> {
		return records(await this.client.get<unknown>('/access/roles')).map(normalizeRole)
	}

	/**
	 * One role's privileges. The endpoint answers with a map of privilege to 1,
	 * which is folded into `privs`; `special` is not reported here.
	 */
	async getRole(roleid: string): Promise<PveRole> {
		const raw = record(
			await this.client.get<unknown>(`/access/roles/${encodeURIComponent(roleid)}`),
		)
		const privs = Object.entries(raw)
			.filter(([, granted]) => toOptionalBoolean(granted) === true)
			.map(([priv]) => priv)
		return { roleid, privs, special: undefined, raw }
	}

	/**
	 * Create a role. `privs` is a comma-separated privilege list; read an
	 * existing role with `getRole` to see the spelling.
	 */
	async createRole(params: AccessRolesPostParams): Promise<void> {
		await this.client.post<null>('/access/roles', params)
	}

	/**
	 * Change a role's privileges. Without `append` the list replaces what was
	 * there. A built-in role cannot be changed.
	 */
	async updateRole(roleid: string, params: AccessRolesPutParams): Promise<void> {
		await this.client.put<null>(`/access/roles/${encodeURIComponent(roleid)}`, params)
	}

	/** Delete a custom role. */
	async deleteRole(roleid: string): Promise<void> {
		await this.client.delete<null>(`/access/roles/${encodeURIComponent(roleid)}`)
	}

	/** Every ACL entry in the cluster. */
	async listAcl(): Promise<AclEntry[]> {
		return records(await this.client.get<unknown>('/access/acl')).map(normalizeAcl)
	}

	/**
	 * Grant or revoke a role on a path. Name the subject with `users`, `groups`
	 * or `tokens`, each a comma-separated list, and `roles` with the roles to
	 * apply. `delete: true` removes those exact grants instead of adding them.
	 * `propagate` defaults to on, which extends the grant to everything below
	 * the path.
	 */
	async setAcl(params: AccessAclPutParams): Promise<void> {
		await this.client.put<null>('/access/acl', params)
	}

	/**
	 * Effective privileges of a user or token, as a map of path to privilege
	 * set. Without `userid` it answers for the caller. This is the call that
	 * says whether a credential can do something, after roles, groups and
	 * propagation are resolved.
	 */
	async permissions(options?: AccessPermissionsGetParams): Promise<EffectivePermissions> {
		return this.client.get<EffectivePermissions>('/access/permissions', options)
	}

	/** Authentication realms. */
	async listRealms(): Promise<AuthRealm[]> {
		return this.client.get<AuthRealm[]>('/access/domains')
	}

	/** One realm's configuration, with the fields its type uses. */
	async getRealm(realm: string): Promise<Record<string, unknown>> {
		return record(await this.client.get<unknown>(`/access/domains/${encodeURIComponent(realm)}`))
	}

	/**
	 * Add a realm. `type` picks the fields that apply: `ldap` and `ad` want
	 * `server1`, `base_dn` and `user_attr`, `openid` wants `issuer-url` and
	 * `client-id`. `check-connection` makes the call fail rather than store a
	 * realm that cannot be reached.
	 */
	async createRealm(params: AccessDomainsPostParams): Promise<void> {
		await this.client.post<null>('/access/domains', params)
	}

	/** Change a realm. `delete` unsets keys. */
	async updateRealm(realm: string, params: AccessDomainsPutParams): Promise<void> {
		await this.client.put<null>(`/access/domains/${encodeURIComponent(realm)}`, params)
	}

	/** Delete a realm. Users in it stop being able to log in. */
	async deleteRealm(realm: string): Promise<void> {
		await this.client.delete<null>(`/access/domains/${encodeURIComponent(realm)}`)
	}

	/**
	 * Import users and groups from an LDAP, AD or OpenID realm into
	 * `user.cfg`. `dry-run` reports what would change without writing.
	 * `remove-vanished` takes a semicolon-separated list of `acl`, `entry` and
	 * `properties` naming what to drop when it is gone upstream. Synced groups
	 * are named `name-$realm`. Returns a UPID.
	 */
	async syncRealm(realm: string, params?: AccessDomainsSyncPostParams): Promise<string> {
		return this.client.post<string>(`/access/domains/${encodeURIComponent(realm)}/sync`, params)
	}

	/** Second factors of every user. */
	async listTfa(): Promise<UserTfa[]> {
		return records(await this.client.get<unknown>('/access/tfa')).map(normalizeUserTfa)
	}

	/** Second factors of one user. */
	async listUserTfa(userid: string): Promise<TfaEntry[]> {
		return records(await this.client.get<unknown>(tfaPath(userid))).map(normalizeTfa)
	}

	async getTfa(userid: string, id: string): Promise<TfaEntry> {
		return normalizeTfa(record(await this.client.get<unknown>(tfaPath(userid, id))))
	}

	/** Which second factors a user can use, personal and realm-enforced. */
	async userTfaTypes(
		userid: string,
		options?: AccessUsersTfaGetParams,
	): Promise<Record<string, unknown>> {
		return record(await this.client.get<unknown>(userPath(userid, '/tfa'), options))
	}

	/**
	 * Add a second factor. Needs a ticket; `password` is the caller's own
	 * password, which PVE asks for on every TFA change. A `webauthn` or `u2f`
	 * entry takes two calls: the first returns a `challenge`, the second sends
	 * it back with `value`.
	 */
	async addTfa(userid: string, params: AccessTfaPostParams): Promise<TfaAdded> {
		return normalizeTfaAdded(record(await this.client.post<unknown>(tfaPath(userid), params)))
	}

	/** Rename or enable and disable a TFA entry. Needs a ticket. */
	async updateTfa(userid: string, id: string, params: AccessTfaPutParams): Promise<void> {
		await this.client.put<null>(tfaPath(userid, id), params)
	}

	/**
	 * Remove a TFA entry. Needs a ticket.
	 *
	 * PVE refuses a DELETE that carries a body, so `password` travels in the
	 * query string and lands in the pveproxy access log.
	 */
	async deleteTfa(userid: string, id: string, options?: AccessTfaDeleteParams): Promise<void> {
		await this.client.delete<null>(tfaPath(userid, id), options)
	}

	/**
	 * Clear the TFA lockout a user hits after repeated failures. Returns true
	 * when a lock was cleared.
	 */
	async unlockTfa(userid: string): Promise<boolean> {
		return this.client.put<boolean>(userPath(userid, '/unlock-tfa'))
	}

	/**
	 * Change a password. Needs a ticket. A user changing their own password
	 * sends the old one as `confirmation-password`; changing someone else's
	 * needs `User.Modify` on that user. A `pam` user's password is the node's
	 * Unix password.
	 */
	async changePassword(params: AccessPasswordPutParams): Promise<void> {
		await this.client.put<null>('/access/password', params)
	}

	/**
	 * Log in and get a ticket. The client does this on its own, so reach for
	 * it only to mint a ticket for something else, such as a console URL.
	 *
	 * `path` with `privs` returns a restricted ticket good for that path alone.
	 * A realm with TFA answers with `needTfa` and a `tfaChallenge` instead of a
	 * usable ticket; send the challenge back as `tfa-challenge` with `otp`.
	 */
	async ticket(params: AccessTicketPostParams): Promise<AuthTicket> {
		return normalizeTicket(record(await this.client.post<unknown>('/access/ticket', params)))
	}

	/**
	 * Check a VNC ticket against a path and privilege set. Resolves when it is
	 * valid and fails otherwise.
	 */
	async verifyVncTicket(params: AccessVncticketPostParams): Promise<void> {
		await this.client.post<null>('/access/vncticket', params)
	}

	/**
	 * Authorization URL for an OpenID realm. Send the user there, then hand the
	 * code they come back with to `openidLogin`.
	 */
	async openidAuthUrl(params: AccessOpenidAuthUrlPostParams): Promise<string> {
		return this.client.post<string>('/access/openid/auth-url', params)
	}

	/** Exchange an OpenID code for a ticket. */
	async openidLogin(params: AccessOpenidLoginPostParams): Promise<AuthTicket> {
		return normalizeTicket(record(await this.client.post<unknown>('/access/openid/login', params)))
	}

	/** Releases the client's sockets and cached ticket. */
	close(): void {
		this.client.close()
	}
}

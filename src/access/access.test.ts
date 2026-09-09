import { afterEach, describe, expect, test } from 'bun:test'
import { AccessApi } from './access.ts'
import { PveTierError } from '../core/errors.ts'
import {
	closeMockClients,
	formFields,
	formObject,
	mockClient,
} from '../core/test-support/api-mock.ts'

afterEach(closeMockClients)

describe('users', () => {
	// Row shapes are what a PVE 9.2 node sends.
	test('a list row has boolean flags, split groups and its tokens', async () => {
		const mock = mockClient()
		mock.reply({
			data: [
				{
					userid: 'agents@pve',
					enable: 1,
					expire: 0,
					groups: 'ops,dev',
					'realm-type': 'pve',
					'totp-locked': 0,
					tokens: [{ tokenid: 'api', expire: 0, privsep: 0 }],
				},
			],
		})
		const [user] = await new AccessApi(mock.client).listUsers({ full: true })
		expect(mock.last().path).toBe('/access/users?full=1')
		expect(user?.enable).toBe(true)
		expect(user?.groups).toEqual(['ops', 'dev'])
		expect(user?.realmType).toBe('pve')
		expect(user?.totpLocked).toBe(false)
		expect(user?.tokens?.[0]?.privsep).toBe(false)
		expect(user?.raw['enable']).toBe(1)
	})

	test('a single user carries groups as an array and tokens as a map', async () => {
		const mock = mockClient()
		mock.reply({
			data: {
				enable: 1,
				groups: ['ops'],
				tokens: { ci: { privsep: 1, expire: 0 }, ro: { privsep: 0 } },
			},
		})
		const user = await new AccessApi(mock.client).getUser('alice@pve')
		expect(mock.last().path).toBe('/access/users/alice%40pve')
		expect(user.userid).toBe('alice@pve')
		expect(user.groups).toEqual(['ops'])
		expect(user.tokens?.map((token) => [token.tokenid, token.privsep])).toEqual([
			['ci', true],
			['ro', false],
		])
	})

	test('user lifecycle', async () => {
		const mock = mockClient()
		const access = new AccessApi(mock.client)
		await access.createUser({ userid: 'alice@pve', email: 'a@b.test', groups: 'ops' })
		expect([mock.last().method, mock.last().path]).toEqual(['POST', '/access/users'])
		expect(formObject(mock.last())).toEqual({
			userid: 'alice@pve',
			email: 'a@b.test',
			groups: 'ops',
		})
		await access.updateUser('alice@pve', { groups: 'ops,dev', append: true, enable: false })
		expect([mock.last().method, mock.last().path]).toEqual(['PUT', '/access/users/alice%40pve'])
		expect(formObject(mock.last())).toEqual({ groups: 'ops,dev', append: '1', enable: '0' })
		await access.deleteUser('alice@pve')
		expect([mock.last().method, mock.last().path]).toEqual(['DELETE', '/access/users/alice%40pve'])
	})
})

describe('tokens', () => {
	test('creating a token returns the secret and addresses both ids', async () => {
		const mock = mockClient()
		mock.reply({
			data: { 'full-tokenid': 'alice@pve!ci', value: 'uuid', info: { privsep: 1 } },
		})
		const created = await new AccessApi(mock.client).createToken('alice@pve', 'ci', {
			comment: 'ci runner',
		})
		expect(created.value).toBe('uuid')
		expect(created.fullTokenId).toBe('alice@pve!ci')
		expect(created.info.tokenid).toBe('ci')
		expect(created.info.privsep).toBe(true)
		expect(mock.last().method).toBe('POST')
		expect(mock.last().path).toBe('/access/users/alice%40pve/token/ci')
		expect(formObject(mock.last())).toEqual({ comment: 'ci runner' })
	})

	test('a token read fills in the id the endpoint leaves out', async () => {
		const mock = mockClient()
		mock.reply({ data: { privsep: 1, expire: 0 } })
		const token = await new AccessApi(mock.client).getToken('alice@pve', 'ci')
		expect(token.tokenid).toBe('ci')
		expect(token.privsep).toBe(true)

		mock.reply({ data: [{ tokenid: 'ci', privsep: 0 }] })
		const [listed] = await new AccessApi(mock.client).listTokens('alice@pve')
		expect(mock.last().path).toBe('/access/users/alice%40pve/token')
		expect(listed?.tokenid).toBe('ci')
	})

	test('an update returns the token and regenerating returns a new secret', async () => {
		const mock = mockClient()
		const access = new AccessApi(mock.client)
		mock.reply({ data: { comment: 'renamed', privsep: 1 } })
		const updated = await access.updateToken('alice@pve', 'ci', { comment: 'renamed' })
		expect(updated.tokenid).toBe('ci')
		expect(updated.comment).toBe('renamed')
		expect(formObject(mock.last())).toEqual({ comment: 'renamed' })

		mock.reply({ data: { 'full-tokenid': 'alice@pve!ci', value: 'new-uuid' } })
		const secret = await access.regenerateToken('alice@pve', 'ci')
		expect(secret.value).toBe('new-uuid')
		expect(secret.info.tokenid).toBe('ci')
		expect(formObject(mock.last())).toEqual({ regenerate: '1' })
	})

	test('deleting a token names the user and the token', async () => {
		const mock = mockClient()
		await new AccessApi(mock.client).deleteToken('alice@pve', 'ci')
		expect(mock.last().method).toBe('DELETE')
		expect(mock.last().path).toBe('/access/users/alice%40pve/token/ci')
	})
})

describe('groups and roles', () => {
	test('members come from either spelling of the member list', async () => {
		const mock = mockClient()
		const access = new AccessApi(mock.client)
		mock.reply({ data: [{ groupid: 'ops', users: 'alice@pve,bob@pve' }] })
		expect((await access.listGroups())[0]?.members).toEqual(['alice@pve', 'bob@pve'])

		mock.reply({ data: { members: ['alice@pve'], comment: 'operators' } })
		const group = await access.getGroup('ops')
		expect(mock.last().path).toBe('/access/groups/ops')
		expect(group.groupid).toBe('ops')
		expect(group.members).toEqual(['alice@pve'])
	})

	test('role rows split privileges and flag the built-in ones', async () => {
		const mock = mockClient()
		const access = new AccessApi(mock.client)
		mock.reply({
			data: [
				{
					roleid: 'PVEDatastoreUser',
					special: 1,
					privs: 'Datastore.Audit,Datastore.AllocateSpace',
				},
			],
		})
		const [role] = await access.listRoles()
		expect(role?.special).toBe(true)
		expect(role?.privs).toEqual(['Datastore.Audit', 'Datastore.AllocateSpace'])

		mock.reply({ data: { 'VM.Audit': 1, 'VM.PowerMgmt': 1 } })
		const single = await access.getRole('Operator')
		expect(mock.last().path).toBe('/access/roles/Operator')
		expect(single.roleid).toBe('Operator')
		expect(single.privs).toEqual(['VM.Audit', 'VM.PowerMgmt'])
	})

	test('group and role lifecycle', async () => {
		const mock = mockClient()
		const access = new AccessApi(mock.client)
		await access.createGroup({ groupid: 'ops', comment: 'operators' })
		expect([mock.last().method, mock.last().path]).toEqual(['POST', '/access/groups'])
		expect(formObject(mock.last())).toEqual({ groupid: 'ops', comment: 'operators' })
		await access.updateGroup('ops', { comment: 'ops team' })
		expect([mock.last().method, mock.last().path]).toEqual(['PUT', '/access/groups/ops'])
		expect(formObject(mock.last())).toEqual({ comment: 'ops team' })
		await access.deleteGroup('ops')
		expect([mock.last().method, mock.last().path]).toEqual(['DELETE', '/access/groups/ops'])

		await access.createRole({ roleid: 'Operator', privs: 'VM.Audit,VM.PowerMgmt' })
		expect([mock.last().method, mock.last().path]).toEqual(['POST', '/access/roles'])
		expect(formObject(mock.last())).toEqual({
			roleid: 'Operator',
			privs: 'VM.Audit,VM.PowerMgmt',
		})
		await access.updateRole('Operator', { privs: 'VM.Console', append: true })
		expect(formObject(mock.last())).toEqual({ privs: 'VM.Console', append: '1' })
		await access.deleteRole('Operator')
		expect([mock.last().method, mock.last().path]).toEqual(['DELETE', '/access/roles/Operator'])
	})
})

describe('acl and permissions', () => {
	test('an acl row has a boolean propagate flag', async () => {
		const mock = mockClient()
		mock.reply({
			data: [{ path: '/', type: 'token', roleid: 'Administrator', ugid: 'a@pve!ci', propagate: 1 }],
		})
		const [entry] = await new AccessApi(mock.client).listAcl()
		expect(entry?.type).toBe('token')
		expect(entry?.propagate).toBe(true)
	})

	test('a grant names subject, roles and path', async () => {
		const mock = mockClient()
		await new AccessApi(mock.client).setAcl({
			path: '/vms/110',
			roles: 'PVEVMAdmin',
			tokens: 'alice@pve!ci',
			propagate: false,
		})
		expect([mock.last().method, mock.last().path]).toEqual(['PUT', '/access/acl'])
		expect(formObject(mock.last())).toEqual({
			path: '/vms/110',
			roles: 'PVEVMAdmin',
			tokens: 'alice@pve!ci',
			propagate: '0',
		})
	})

	test('revoking is the same call with delete set', async () => {
		const mock = mockClient()
		await new AccessApi(mock.client).setAcl({
			path: '/vms/110',
			roles: 'PVEVMAdmin',
			users: 'alice@pve',
			delete: true,
		})
		expect(formFields(mock.last()).get('delete')).toBe('1')
	})

	test('permissions asks for one subject', async () => {
		const mock = mockClient()
		mock.reply({ data: { '/': { 'Sys.Audit': 1 } } })
		const permissions = await new AccessApi(mock.client).permissions({
			userid: 'alice@pve',
			path: '/',
		})
		expect(mock.last().path).toBe('/access/permissions?userid=alice%40pve&path=%2F')
		expect(permissions['/']?.['Sys.Audit']).toBe(1)
	})
})

describe('realms', () => {
	test('realm lifecycle', async () => {
		const mock = mockClient()
		const access = new AccessApi(mock.client)
		mock.reply({
			data: [{ realm: 'pve', type: 'pve', comment: 'Proxmox VE authentication server' }],
		})
		expect((await access.listRealms())[0]?.type).toBe('pve')

		await access.createRealm({
			realm: 'ldap',
			type: 'ldap',
			server1: '10.0.0.8',
			base_dn: 'dc=lan',
			user_attr: 'uid',
			'check-connection': true,
		})
		expect([mock.last().method, mock.last().path]).toEqual(['POST', '/access/domains'])
		expect(formObject(mock.last())).toEqual({
			realm: 'ldap',
			type: 'ldap',
			server1: '10.0.0.8',
			base_dn: 'dc=lan',
			user_attr: 'uid',
			'check-connection': '1',
		})
		await access.updateRealm('ldap', { comment: 'corp', delete: 'server2' })
		expect([mock.last().method, mock.last().path]).toEqual(['PUT', '/access/domains/ldap'])
		expect(formObject(mock.last())).toEqual({ comment: 'corp', delete: 'server2' })
		await access.deleteRealm('ldap')
		expect([mock.last().method, mock.last().path]).toEqual(['DELETE', '/access/domains/ldap'])
	})

	test('a sync returns a UPID', async () => {
		const mock = mockClient()
		mock.reply({ data: 'UPID:ms01-0160:1:1:1:realmsync:ldap:root@pam:' })
		const upid = await new AccessApi(mock.client).syncRealm('ldap', {
			scope: 'both',
			'dry-run': true,
		})
		expect(upid).toStartWith('UPID:')
		expect(mock.last().path).toBe('/access/domains/ldap/sync')
		expect(formObject(mock.last())).toEqual({ scope: 'both', 'dry-run': '1' })
	})
})

describe('tfa', () => {
	test('reads normalize entries and lock state', async () => {
		const mock = mockClient()
		const access = new AccessApi(mock.client)
		mock.reply({
			data: [
				{
					userid: 'alice@pve',
					'totp-locked': 1,
					'tfa-locked-until': 1700000000,
					entries: [{ id: 'totp-1', type: 'totp', enable: 1, created: 1690000000 }],
				},
			],
		})
		const [user] = await access.listTfa()
		expect(user?.userid).toBe('alice@pve')
		expect(user?.totpLocked).toBe(true)
		expect(user?.tfaLockedUntil).toBe(1700000000)
		expect(user?.entries[0]?.enable).toBe(true)

		mock.reply({ data: [{ id: 'totp-1', type: 'totp', enable: 0 }] })
		expect((await access.listUserTfa('alice@pve'))[0]?.enable).toBe(false)
		expect(mock.last().path).toBe('/access/tfa/alice%40pve')

		mock.reply({ data: { id: 'totp-1', type: 'totp', description: 'phone' } })
		expect((await access.getTfa('alice@pve', 'totp-1')).description).toBe('phone')
		expect(mock.last().path).toBe('/access/tfa/alice%40pve/totp-1')

		mock.reply({ data: { types: ['totp'] } })
		await access.userTfaTypes('alice@pve', { multiple: true })
		expect(mock.last().path).toBe('/access/users/alice%40pve/tfa?multiple=1')
	})

	test('writes run on the ticket', async () => {
		const mock = mockClient()
		const access = new AccessApi(mock.client)
		mock.reply({ data: { id: 'recovery-1', recovery: ['aaaa-bbbb', 'cccc-dddd'] } })
		const added = await access.addTfa('alice@pve', { type: 'recovery', password: 'own' })
		expect([mock.last().method, mock.last().path]).toEqual(['POST', '/access/tfa/alice%40pve'])
		expect(mock.last().headers['cookie']).toContain('PVEAuthCookie=')
		expect(mock.last().headers['authorization']).toBeUndefined()
		expect(formObject(mock.last())).toEqual({ type: 'recovery', password: 'own' })
		expect(added.id).toBe('recovery-1')
		expect(added.recovery).toEqual(['aaaa-bbbb', 'cccc-dddd'])
		expect(added.challenge).toBeUndefined()

		await access.updateTfa('alice@pve', 'totp-1', { enable: false, password: 'own' })
		expect([mock.last().method, mock.last().path]).toEqual([
			'PUT',
			'/access/tfa/alice%40pve/totp-1',
		])
		expect(formObject(mock.last())).toEqual({ enable: '0', password: 'own' })

		mock.reply({ data: 1 })
		expect(await access.unlockTfa('alice@pve')).toBe(true)
		expect(mock.last().path).toBe('/access/users/alice%40pve/unlock-tfa')
	})

	test('a delete needs a ticket and puts the password in the query string', async () => {
		const mock = mockClient()
		await new AccessApi(mock.client).deleteTfa('alice@pve', 'totp-1', { password: 'own-password' })
		expect(mock.last().method).toBe('DELETE')
		expect(mock.last().path).toBe('/access/tfa/alice%40pve/totp-1?password=own-password')
		expect(mock.last().body).toBe('')
		expect(mock.last().headers['cookie']).toContain('PVEAuthCookie=')
	})
})

describe('tickets and passwords', () => {
	test('a password change runs on the ticket, never the token', async () => {
		const mock = mockClient()
		await new AccessApi(mock.client).changePassword({
			userid: 'alice@pve',
			password: 'new-password',
		})
		expect([mock.last().method, mock.last().path]).toEqual(['PUT', '/access/password'])
		expect(mock.last().headers['cookie']).toContain('PVEAuthCookie=')
		expect(mock.last().headers['authorization']).toBeUndefined()
	})

	test('without a ticket the call says which credential is missing', async () => {
		const mock = mockClient({ ticket: false })
		await expect(
			new AccessApi(mock.client).changePassword({ userid: 'alice@pve', password: 'x' }),
		).rejects.toBeInstanceOf(PveTierError)
		expect(mock.requests).toHaveLength(0)
	})

	test('minting a path-scoped ticket runs without the token', async () => {
		// The fake API answers every ticket login itself, this call included.
		const mock = mockClient()
		const ticket = await new AccessApi(mock.client).ticket({
			username: 'alice@pve',
			password: 'p',
			path: '/vms/110',
			privs: 'VM.Console',
		})
		expect(mock.last().path).toBe('/access/ticket')
		expect(mock.last().headers['authorization']).toBeUndefined()
		expect(formObject(mock.last())).toEqual({
			username: 'alice@pve',
			password: 'p',
			path: '/vms/110',
			privs: 'VM.Console',
		})
		expect(ticket.ticket).toBe('PVE:alice@pve:TICKET')
		expect(ticket.csrfToken).toBe('CSRF')
		expect(ticket.needTfa).toBeUndefined()
	})

	test('vnc ticket verification and the openid handshake', async () => {
		const mock = mockClient()
		const access = new AccessApi(mock.client)
		await access.verifyVncTicket({
			vncticket: 'PVEVNC:xyz',
			authid: 'alice@pve',
			path: '/vms/110',
			privs: 'VM.Console',
		})
		expect([mock.last().method, mock.last().path]).toEqual(['POST', '/access/vncticket'])
		expect(formObject(mock.last())).toEqual({
			vncticket: 'PVEVNC:xyz',
			authid: 'alice@pve',
			path: '/vms/110',
			privs: 'VM.Console',
		})

		mock.reply({ data: 'https://idp.test/authorize?state=s' })
		expect(
			await access.openidAuthUrl({ realm: 'oidc', 'redirect-url': 'https://pve.test' }),
		).toStartWith('https://idp.test')
		expect(mock.last().path).toBe('/access/openid/auth-url')
		expect(formObject(mock.last())).toEqual({ realm: 'oidc', 'redirect-url': 'https://pve.test' })

		mock.reply({ data: { ticket: 'PVE:alice@pve:T', username: 'alice@pve' } })
		const ticket = await access.openidLogin({
			code: 'c',
			state: 's',
			'redirect-url': 'https://pve.test',
		})
		expect(ticket.username).toBe('alice@pve')
		expect(mock.last().path).toBe('/access/openid/login')
		expect(formObject(mock.last())).toEqual({
			code: 'c',
			state: 's',
			'redirect-url': 'https://pve.test',
		})
	})
})

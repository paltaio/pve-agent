import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { AccessApi } from '../../src/index.ts'
import { LIVE, liveSession, MINUTE, SECOND } from './support.ts'

const TEST_USER = 'pveagent-test@pve'
const TEST_TOKEN = 't1'
const TEST_TOKEN_ID = `${TEST_USER}!${TEST_TOKEN}`
const ACL_PATH = '/vms/9000'
const ACL_ROLE = 'PVEAuditor'

const session = liveSession()

async function removeTestUser(access: AccessApi): Promise<void> {
	const grants = await access.listAcl()
	if (grants.some((entry) => entry.path === ACL_PATH && entry.ugid === TEST_TOKEN_ID)) {
		await access.setAcl({ path: ACL_PATH, tokens: TEST_TOKEN_ID, roles: ACL_ROLE, delete: true })
	}
	const users = await access.listUsers()
	if (users.some((user) => user.userid === TEST_USER)) await access.deleteUser(TEST_USER)
}

describe.skipIf(!LIVE)('access', () => {
	beforeAll(async () => {
		const cluster = await session.open()
		await removeTestUser(cluster.access)
	}, MINUTE)
	afterAll(async () => {
		await removeTestUser(session.cluster().access)
		await session.close()
	}, MINUTE)

	test(
		'the user list has the root and the API user',
		async () => {
			const users = await session.cluster().access.listUsers()
			const ids = users.map((user) => user.userid)
			expect(ids).toContain('root@pam')
			expect(ids).toContain('agents@pve')
		},
		30 * SECOND,
	)

	test(
		'a user, a token and an ACL grant are created and found',
		async () => {
			const access = session.cluster().access
			await access.createUser({ userid: TEST_USER, comment: 'live suite scratch user' })
			const secret = await access.createToken(TEST_USER, TEST_TOKEN)
			expect(secret.fullTokenId).toBe(TEST_TOKEN_ID)
			expect(secret.value.length).toBeGreaterThan(0)

			await access.setAcl({ path: ACL_PATH, tokens: TEST_TOKEN_ID, roles: ACL_ROLE })

			expect((await access.getUser(TEST_USER)).userid).toBe(TEST_USER)
			const tokens = await access.listTokens(TEST_USER)
			expect(tokens.map((token) => token.tokenid)).toContain(TEST_TOKEN)
			const grant = (await access.listAcl()).find(
				(entry) => entry.path === ACL_PATH && entry.ugid === TEST_TOKEN_ID,
			)
			expect(grant?.type).toBe('token')
			expect(grant?.roleid).toBe(ACL_ROLE)
		},
		MINUTE,
	)

	test(
		'the grant, the token and the user are deleted again',
		async () => {
			const access = session.cluster().access
			await access.setAcl({ path: ACL_PATH, tokens: TEST_TOKEN_ID, roles: ACL_ROLE, delete: true })
			await access.deleteToken(TEST_USER, TEST_TOKEN)
			await access.deleteUser(TEST_USER)

			const grants = await access.listAcl()
			expect(grants.some((entry) => entry.ugid === TEST_TOKEN_ID)).toBe(false)
			const users = await access.listUsers()
			expect(users.some((user) => user.userid === TEST_USER)).toBe(false)
		},
		MINUTE,
	)
})

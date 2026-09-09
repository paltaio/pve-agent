import { afterEach, describe, expect, test } from 'bun:test'
import { encodeParams, PveClient, unwrapEnvelope, type RequestTrace } from './client.ts'
import {
	PveApiError,
	PveAuthError,
	PveConfigError,
	PveNotFoundError,
	PvePermissionError,
	PveTierError,
} from './errors.ts'
import { closeMockClients, formObject, mockClient, multipart } from './test-support/api-mock.ts'

afterEach(closeMockClients)

describe('encodeParams', () => {
	test('sends booleans as 1 and 0', () => {
		expect(encodeParams({ start: true, force: false }).toString()).toBe('start=1&force=0')
	})

	test('repeats the key for an array', () => {
		expect(encodeParams({ command: ['sh', '-c', 'id'] }).toString()).toBe(
			'command=sh&command=-c&command=id',
		)
	})

	test('drops undefined and null', () => {
		expect(encodeParams({ a: 1, b: undefined, c: null }).toString()).toBe('a=1')
	})

	test('names the parameter when the value is not encodable', () => {
		expect(() => encodeParams({ net0: { bridge: 'vmbr0' } })).toThrow(PveConfigError)
		expect(() => encodeParams({ net0: { bridge: 'vmbr0' } })).toThrow(/'net0' is a object/)
		expect(() => encodeParams({ cores: Number.NaN })).toThrow(/'cores' is NaN/)
	})
})

describe('request shaping', () => {
	test('a DELETE puts its parameters in the query string and sends no body', async () => {
		const mock = mockClient()
		await mock.client.delete('/nodes/ms01/qemu/9029', {
			purge: true,
			'destroy-unreferenced-disks': false,
		})
		const sent = mock.last()
		expect(sent.method).toBe('DELETE')
		expect(sent.path).toBe('/nodes/ms01/qemu/9029?purge=1&destroy-unreferenced-disks=0')
		expect(sent.body).toBe('')
		expect(sent.headers['content-type']).toBeUndefined()
	})

	test('a DELETE with no parameters sends no query', async () => {
		const mock = mockClient()
		await mock.client.delete('/nodes/ms01/qemu/9029')
		expect(mock.last().path).toBe('/nodes/ms01/qemu/9029')
	})

	test('a GET puts its parameters in the query string', async () => {
		const mock = mockClient()
		await mock.client.get('/cluster/resources', { type: 'vm' })
		expect(mock.last().method).toBe('GET')
		expect(mock.last().path).toBe('/cluster/resources?type=vm')
		expect(mock.last().body).toBe('')
	})

	test('POST and PUT send their parameters as a form body', async () => {
		const mock = mockClient()
		await mock.client.post('/nodes/ms01/qemu', { vmid: 9001, name: 'probe' })
		expect(mock.last().path).toBe('/nodes/ms01/qemu')
		expect(mock.last().headers['content-type']).toBe('application/x-www-form-urlencoded')
		expect(formObject(mock.last())).toEqual({ vmid: '9001', name: 'probe' })

		await mock.client.put('/nodes/ms01/qemu/9001/config', { cores: 2 })
		expect(mock.last().method).toBe('PUT')
		expect(formObject(mock.last())).toEqual({ cores: '2' })
	})

	test('a POST without parameters sends no body and no content type', async () => {
		const mock = mockClient()
		await mock.client.post('/nodes/ms01/qemu/9001/status/start')
		expect(mock.last().body).toBe('')
		expect(mock.last().headers['content-type']).toBeUndefined()
	})

	test('a multipart body goes out as given', async () => {
		const mock = mockClient()
		const form = new FormData()
		form.set('content', 'iso')
		form.set('filename', new Blob(['hello']), 'probe.iso')
		await mock.client.post('/nodes/ms01/storage/local/upload', undefined, { body: form })
		expect(mock.last().headers['content-type']).toStartWith('multipart/form-data')
		expect(multipart(mock.last())).toEqual({
			content: { text: 'iso', filename: undefined },
			filename: { text: 'hello', filename: 'probe.iso' },
		})
	})

	test('refuses a body next to parameters', async () => {
		const mock = mockClient()
		await expect(
			mock.client.post('/nodes/ms01/storage/local/upload', { content: 'iso' }, { body: 'x' }),
		).rejects.toThrow(PveConfigError)
		expect(mock.requests).toHaveLength(0)
	})

	test('extra headers ride along', async () => {
		const mock = mockClient()
		await mock.client.get('/version', undefined, { headers: { 'X-Probe': 'yes' } })
		expect(mock.last().headers['x-probe']).toBe('yes')
		expect(mock.last().headers['accept']).toBe('application/json')
	})

	test('an abort signal cancels the request', async () => {
		const mock = mockClient()
		mock.reply({ delayMs: 5_000 })
		const controller = new AbortController()
		const call = mock.client.get('/version', undefined, { signal: controller.signal })
		controller.abort(new Error('cancelled'))
		await expect(call).rejects.toThrow('cancelled')
	})
})

describe('credentials on the wire', () => {
	test('a token call carries the Authorization header and no CSRF token', async () => {
		const mock = mockClient()
		await mock.client.post('/nodes/ms01/qemu/100/status/start')
		const sent = mock.last()
		expect(sent.headers['authorization']).toBe('PVEAPIToken=agents@pve!ci=secret')
		expect(sent.headers['cookie']).toBeUndefined()
		expect(sent.headers['csrfpreventiontoken']).toBeUndefined()
		expect(mock.requests).toHaveLength(1)
	})

	test('a ticket call logs in once, then sends the cookie and CSRF on writes', async () => {
		const mock = mockClient({ token: false, ticket: 'agents@pve' })
		await mock.client.get('/version')
		await mock.client.put('/nodes/ms01/qemu/100/config', { cores: 1 })

		expect(mock.requests.map((entry) => entry.path)).toEqual([
			'/access/ticket',
			'/version',
			'/nodes/ms01/qemu/100/config',
		])
		const login = mock.requests[0]
		expect(login && formObject(login)).toEqual({ username: 'agents@pve', password: 'password' })
		const read = mock.requests[1]
		expect(read?.headers['cookie']).toBe('PVEAuthCookie=PVE%3Aagents%40pve%3ATICKET')
		expect(read?.headers['csrfpreventiontoken']).toBeUndefined()
		expect(read?.headers['authorization']).toBeUndefined()
		const write = mock.requests[2]
		expect(write?.headers['cookie']).toBe('PVEAuthCookie=PVE%3Aagents%40pve%3ATICKET')
		expect(write?.headers['csrfpreventiontoken']).toBe('CSRF')
	})

	test('one 401 on a ticket call forces a fresh login and a single retry', async () => {
		const traces: RequestTrace[] = []
		const mock = mockClient({ token: false, onRequest: (trace) => traces.push(trace) })
		mock.reply({ status: 401, body: '{"data":null}' })
		mock.reply({ data: { version: '9.2' } })

		await expect(mock.client.get('/version')).resolves.toEqual({ version: '9.2' })
		expect(mock.requests.map((entry) => entry.path)).toEqual([
			'/access/ticket',
			'/version',
			'/access/ticket',
			'/version',
		])
		expect(traces.map((trace) => trace.attempt)).toEqual([1, 2])
	})

	test('a second 401 is an auth error', async () => {
		const mock = mockClient({ token: false })
		mock.reply({ status: 401, body: '{"data":null}' })
		mock.reply({ status: 401, body: '{"data":null}' })
		await expect(mock.client.get('/version')).rejects.toThrow(PveAuthError)
		expect(mock.calls()).toHaveLength(2)
	})

	test('a 403 is a permission error and is not retried on either tier', async () => {
		const ticket = mockClient({ token: false })
		ticket.reply({ status: 403, body: '{"data":null,"message":"Permission check failed"}' })
		await expect(ticket.client.get('/version')).rejects.toThrow(PvePermissionError)
		expect(ticket.calls()).toHaveLength(1)

		const token = mockClient()
		token.reply({ status: 403, body: '{"data":null}' })
		await expect(token.client.get('/version')).rejects.toThrow(PvePermissionError)
		expect(token.requests).toHaveLength(1)
	})

	test('a 401 names the tier the API rejected', async () => {
		const mock = mockClient()
		mock.reply({ status: 401, body: '{"data":null,"message":"invalid token"}' })
		const error = await mock.client.get('/version').catch((e: unknown) => e)
		expect(error).toBeInstanceOf(PveAuthError)
		expect(error).toHaveProperty('tier', 'token')
	})
})

describe('tier selection', () => {
	test('uses the token for an ordinary call', () => {
		const { client } = mockClient()
		const decision = client.requiredTier('GET', '/nodes/ms01/qemu/100/config')
		expect(decision.tier).toBe('token')
		expect(decision.requiresRootPam).toBe(false)
		expect(decision.endpoint?.path).toBe('/nodes/{node}/qemu/{vmid}/config')
		expect(decision.rootOnlyParams).toEqual([])
	})

	test('needs a root@pam ticket for an endpoint with no permissions block', () => {
		const decision = mockClient().client.requiredTier('PUT', '/nodes/ms01/disks/wipedisk')
		expect(decision.tier).toBe('ticket')
		expect(decision.requiresRootPam).toBe(true)
	})

	test('needs a ticket when the endpoint forbids tokens', () => {
		const decision = mockClient().client.requiredTier('PUT', '/access/password')
		expect(decision.tier).toBe('ticket')
		expect(decision.requiresRootPam).toBe(false)
	})

	test('escalates for a root-only parameter and stays on the token without it', () => {
		const { client } = mockClient()
		const path = '/nodes/ms01/qemu/100/status/start'
		const escalated = client.requiredTier('POST', path, { skiplock: true })
		expect(escalated.requiresRootPam).toBe(true)
		expect(escalated.rootOnlyParams.map((hit) => hit.param)).toEqual(['skiplock'])
		expect(escalated.reason).toContain("parameter 'skiplock'")
		expect(client.requiredTier('POST', path, {}).tier).toBe('token')
	})

	test('looks at the value of an indexed parameter', () => {
		const { client } = mockClient()
		const path = '/nodes/ms01/lxc/100/config'
		expect(client.requiredTier('PUT', path, { mp0: '/srv/host,mp=/data' }).requiresRootPam).toBe(
			true,
		)
		expect(client.requiredTier('PUT', path, { mp0: 'local-zfs:8,mp=/data' }).tier).toBe('token')
		expect(
			client.requiredTier('PUT', '/nodes/ms01/qemu/100/config', { hostpci0: 'mapping=gpu' }).tier,
		).toBe('token')
	})

	test('names the missing credential instead of sending the call', async () => {
		const mock = mockClient({ ticket: false })
		const error = await mock.client.get('/cluster/backup-info').catch((e: unknown) => e)
		expect(error).toBeInstanceOf(PveTierError)
		expect(error).toHaveProperty('required', 'ticket')
		expect(error).toHaveProperty('available', ['token'])
		expect(error).toHaveProperty('message', expect.stringContaining('PVE_USER=root@pam'))
		expect(mock.requests).toHaveLength(0)
	})

	test('says the ticket user is wrong when one is configured', async () => {
		const mock = mockClient({ ticket: 'agents@pve' })
		await expect(mock.client.get('/cluster/backup-info')).rejects.toThrow(
			/ticket user is agents@pve/,
		)
		expect(mock.requests).toHaveLength(0)
	})

	test('a root@pam ticket reaches a root-only endpoint', async () => {
		const mock = mockClient()
		mock.reply({ data: [] })
		await mock.client.get('/cluster/backup-info')
		expect(mock.last().headers['cookie']).toStartWith('PVEAuthCookie=')
	})

	test('falls back to the ticket when there is no token', () => {
		const { client } = mockClient({ token: false, ticket: 'agents@pve' })
		const decision = client.requiredTier('GET', '/version')
		expect(decision.tier).toBe('ticket')
		expect(decision.reason).toBe('no API token is configured')
		expect(client.auth.tiers).toEqual(['ticket'])
	})

	test('the caller can force a tier', async () => {
		const mock = mockClient({ ticket: 'agents@pve' })
		await mock.client.get('/version', undefined, { tier: 'ticket' })
		expect(mock.last().headers['cookie']).toStartWith('PVEAuthCookie=')
		expect(mock.last().headers['authorization']).toBeUndefined()

		const forcedToken = mockClient()
		await forcedToken.client.get('/cluster/backup-info', undefined, { tier: 'token' })
		expect(forcedToken.last().headers['authorization']).toStartWith('PVEAPIToken=')
	})

	test('forcing an absent tier is a tier error', async () => {
		const mock = mockClient({ ticket: false })
		await expect(mock.client.get('/version', undefined, { tier: 'ticket' })).rejects.toThrow(
			PveTierError,
		)
		expect(mock.requests).toHaveLength(0)
	})

	test('refuses a path outside the registry unless told otherwise', async () => {
		const mock = mockClient()
		await expect(mock.client.get('/nodes/ms01/typo')).rejects.toThrow(PveConfigError)
		expect(mock.requests).toHaveLength(0)
		expect(mock.client.endpointFor('GET', '/nodes/ms01/typo')).toBeUndefined()

		mock.reply({ data: 'ok' })
		await expect(
			mock.client.get('/nodes/ms01/typo', undefined, { allowUnknownEndpoint: true }),
		).resolves.toBe('ok')
		expect(mock.last().path).toBe('/nodes/ms01/typo')
	})

	test('reports the tier decision through onRequest before sending', async () => {
		const traces: RequestTrace[] = []
		const mock = mockClient({ onRequest: (trace) => traces.push(trace) })
		mock.reply({ data: [] })
		await mock.client.get('/version')
		await mock.client.get('/cluster/backup-info')

		expect(traces).toHaveLength(2)
		expect(traces[0]).toMatchObject({
			method: 'GET',
			path: '/version',
			endpointPath: '/version',
			escalated: false,
			attempt: 1,
		})
		expect(traces[0]?.decision.tier).toBe('token')
		expect(traces[1]).toMatchObject({
			path: '/cluster/backup-info',
			endpointPath: '/cluster/backup-info',
			escalated: true,
			attempt: 1,
		})
		expect(traces[1]?.decision.requiresRootPam).toBe(true)
	})
})

describe('responses', () => {
	test('returns the data field', async () => {
		const mock = mockClient()
		mock.reply({ data: { version: '9.2.11', release: '9.2' } })
		await expect(mock.client.get('/version')).resolves.toEqual({
			version: '9.2.11',
			release: '9.2',
		})
	})

	test('withAttribs returns the keys beside data', async () => {
		const mock = mockClient()
		mock.reply({ data: [{ iface: 'vmbr0' }], attribs: { changes: '+auto vmbr1' } })
		const result = await mock.client.request<{ iface: string }[]>(
			'GET',
			'/nodes/ms01/network',
			undefined,
			{ withAttribs: true },
		)
		expect(result.data).toEqual([{ iface: 'vmbr0' }])
		expect(result.attribs).toEqual({ changes: '+auto vmbr1' })
	})

	test('a 404 and a 501 are not found', async () => {
		const mock = mockClient()
		mock.reply({ status: 404, body: '{"data":null,"message":"no such node"}' })
		await expect(mock.client.get('/nodes/nope/status')).rejects.toThrow(PveNotFoundError)
		mock.reply({ status: 501, body: '{"data":null,"message":"not implemented"}' })
		await expect(mock.client.get('/nodes/nope/status')).rejects.toThrow(PveNotFoundError)
	})

	test('a 500 naming a missing config maps to not found', async () => {
		const mock = mockClient()
		mock.reply({
			status: 500,
			body: JSON.stringify({
				message: "Configuration file 'nodes/ms01/qemu-server/999999999.conf' does not exist\n",
				data: null,
			}),
		})
		await expect(mock.client.get('/nodes/ms01/qemu/999999999/config')).rejects.toThrow(
			PveNotFoundError,
		)
	})

	test('a 400 keeps its per-parameter messages even when one says does not exist', async () => {
		const mock = mockClient()
		mock.reply({
			status: 400,
			body: JSON.stringify({
				errors: { storage: "storage 'nope' does not exist" },
				message: 'Parameter verification failed.\n',
				data: null,
			}),
		})
		const error = await mock.client
			.post('/nodes/ms01/qemu', { vmid: 100, storage: 'nope' })
			.catch((e: unknown) => e)
		expect(error).toBeInstanceOf(PveApiError)
		expect(error).toHaveProperty('status', 400)
		expect(error).toHaveProperty('errors', { storage: "storage 'nope' does not exist" })
		expect(error).toHaveProperty('message', expect.stringContaining('Parameter errors: storage:'))
	})

	test('a 200 whose body is not JSON names the body', async () => {
		const mock = mockClient()
		mock.reply({ body: '<html><head><title>502 Bad Gateway</title></head></html>' })
		const error = await mock.client.get('/version').catch((e: unknown) => e)
		expect(error).toBeInstanceOf(PveApiError)
		expect(error).toHaveProperty('message', expect.stringContaining('502 Bad Gateway'))
	})

	test('a 200 with an empty body or no data field is undefined', async () => {
		const mock = mockClient()
		mock.reply({ body: '' })
		await expect(mock.client.delete('/nodes/ms01/qemu/100')).resolves.toBeUndefined()
		mock.reply({ body: '{"success":1}' })
		await expect(mock.client.get('/version')).resolves.toBeUndefined()
	})
})

describe('unwrapEnvelope', () => {
	test('reads data from a raw response', () => {
		expect(
			unwrapEnvelope<{ version: string }>('GET', '/version', 'token', {
				status: 200,
				ok: true,
				body: '{"data":{"version":"9.2.11"}}',
			}),
		).toEqual({ version: '9.2.11' })
	})

	test('maps a 403 to the tier that was rejected', () => {
		expect(() =>
			unwrapEnvelope('GET', '/version', 'ticket', {
				status: 403,
				ok: false,
				body: '{"data":null,"message":"Permission check failed"}',
			}),
		).toThrow(/ticket credential/)
	})
})

describe('signRequest', () => {
	test('returns the URL and headers without sending', async () => {
		const mock = mockClient()
		const signed = await mock.client.signRequest(
			'GET',
			'/nodes/ms01/storage/local/file-restore/download',
			{
				volume: 'local:backup/x.vma',
				filepath: '/etc/hostname',
			},
		)
		expect(signed.url).toBe(
			`${mock.client.baseUrl}/api2/json/nodes/ms01/storage/local/file-restore/download?volume=local%3Abackup%2Fx.vma&filepath=%2Fetc%2Fhostname`,
		)
		expect(signed.headers['Authorization']).toBe('PVEAPIToken=agents@pve!ci=secret')
		expect(mock.requests).toHaveLength(0)
	})

	test('a ticket signature logs in first', async () => {
		const mock = mockClient({ token: false })
		const signed = await mock.client.signRequest('POST', '/nodes/ms01/qemu/100/vncproxy')
		expect(signed.headers['Cookie']).toBe('PVEAuthCookie=PVE%3Aroot%40pam%3ATICKET')
		expect(signed.headers['CSRFPreventionToken']).toBe('CSRF')
		expect(mock.requests.map((entry) => entry.path)).toEqual(['/access/ticket'])
	})
})

describe('construction', () => {
	test('fromEnv reads the credential file and passes client options through', async () => {
		const path = `${process.env['TMPDIR'] ?? '/tmp'}/pve-agent-client-${process.pid}.env`
		await Bun.write(
			path,
			'PVE_HOST=node.test\nPVE_NODE=ms01\nPVE_TOKEN_ID=agents@pve!ci\nPVE_TOKEN_SECRET=s\nPVE_VERIFY_SSL=0\n',
		)
		const traces: RequestTrace[] = []
		const client = PveClient.fromEnv({
			envFile: path,
			timeoutMs: 1234,
			onRequest: (trace) => traces.push(trace),
		})
		expect(client.baseUrl).toBe('https://node.test:8006')
		expect(client.defaultNode).toBe('ms01')
		expect(client.http.timeoutMs).toBe(1234)
		expect(client.http.verifySsl).toBe(false)
		expect(client.auth.tiers).toEqual(['token'])
		client.close()
	})

	test('refuses to build without any credential', () => {
		expect(
			() =>
				new PveClient({
					credentials: { connection: { host: 'h', port: 8006, verifySsl: true } },
				}),
		).toThrow(PveConfigError)
	})

	test('task helpers go through the client', async () => {
		const mock = mockClient()
		const upid = 'UPID:ms01-0160:0007A1F2:0121C6B4:65F4A0E2:qmstart:110:agents@pve!ci:'
		mock.reply({ data: { status: 'stopped', exitstatus: 'OK' } })
		const status = await mock.client.waitForTask(upid)
		expect(status.outcome).toBe('ok')
		expect(mock.last().path).toBe(
			'/nodes/ms01-0160/tasks/UPID%3Ams01-0160%3A0007A1F2%3A0121C6B4%3A65F4A0E2%3Aqmstart%3A110%3Aagents%40pve!ci%3A/status',
		)
		mock.reply({ data: [{ n: 1, t: 'line one' }] })
		await expect(mock.client.taskLog(upid)).resolves.toEqual(['line one'])
		mock.reply({ data: { status: 'running' } })
		await expect(mock.client.taskStatus(upid)).resolves.toHaveProperty('status', 'running')
	})
})

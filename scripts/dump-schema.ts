// Reads the API schema off a Proxmox VE node and writes it to schema/.
// Usage: bun run scripts/dump-schema.ts root@<node>

import { $ } from 'bun'
import { resolve } from 'node:path'

const host = process.argv[2]
if (!host) {
	console.error('usage: bun run scripts/dump-schema.ts root@<node>')
	process.exit(2)
}

const apidocPath = '/usr/share/pve-docs/api-viewer/apidoc.js'
const source = await $`ssh ${host} cat ${apidocPath}`.text()
const prefix = 'const apiSchema = '
const start = source.indexOf(prefix)
const end = source.indexOf('\n]\n;', start)
if (start < 0 || end < 0) {
	console.error(`${apidocPath} on ${host} does not look like an api-viewer schema`)
	process.exit(1)
}

const schema: unknown = JSON.parse(source.slice(start + prefix.length, end + 2))
const version = (await $`ssh ${host} pveversion`.text()).trim()

const outDir = resolve(import.meta.dir, '../schema')
await Bun.write(resolve(outDir, 'apidoc.json'), JSON.stringify(schema, null, '\t') + '\n')
await Bun.write(resolve(outDir, 'pve-version.txt'), version + '\n')
console.log(`wrote schema/apidoc.json and schema/pve-version.txt from ${version}`)

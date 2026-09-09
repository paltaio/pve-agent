# pve-agent

Bun library and coding-agent skill for Proxmox VE.

- 537 REST endpoints from a PVE 9.2 schema, typed parameters and privilege flags
- QEMU and LXC guests: lifecycle, config, snapshots, cloning, migration, firewall
- VNC keyboard, mouse and framebuffer; screenshots; screen matchers
- Serial consoles through a headless terminal, with login and prompt detection
- Commands inside a guest through the QEMU guest agent or `pct exec`
- Root shell on a node over SSH or termproxy, with ZFS, systemd, apt, `qm`
  and `pct` helpers; the policy refuses destructive commands unless the shell
  is opened with `destructive: 'allow'`
- Property-string parsing and formatting generated from the schema

## Install

The skill, for every agent CLI found on this machine:

```sh
curl -fsSL https://raw.githubusercontent.com/paltaio/pve-agent/main/install-pve-skill | bash
```

The installer detects Claude Code, Codex, OpenCode, Gemini CLI, Cursor,
Copilot CLI, Amp, Goose and Droid and installs into `~/.claude/skills` or the
shared `~/.agents/skills`; `PVE_SKILL_TARGETS` overrides the targets and
`PVE_SKILL_LIST=1` prints the targets and exits. It writes `pve.env` next to
the skill from `PVE_HOST` and a credential pair, prompting for them when unset.

The library, as a dependency:

```sh
bun add github:paltaio/pve-agent
```

Credentials: the environment, `./pve.env`, or the file `PVE_ENV_FILE` names:

```sh
PVE_HOST=192.0.2.10
PVE_PORT=8006
PVE_NODE=pve1
PVE_TOKEN_ID=automation@pve!ci
PVE_TOKEN_SECRET=...
PVE_USER=root@pam
PVE_PASSWORD=...
```

## First script

```ts
import pve from 'pve-agent'

await using cluster = await pve.connect()

for (const guest of await cluster.list()) {
	console.log(`${guest.vmid} ${guest.type} ${guest.node} ${guest.name} ${guest.status}`)
}

const vm = cluster.vm(100)
console.log(await vm.guest.output(['uname', '-a']))

const shot = await vm.kvm.screenshot({ format: 'png' })
await Bun.write('vm-100.png', shot.data)
```

## Documentation

- [docs/getting-started.md](docs/getting-started.md): install, credentials, connecting, handles, creating a guest
- [docs/auth.md](docs/auth.md): the token, the root ticket, root SSH, and how the client picks
- [docs/guests.md](docs/guests.md): QEMU VMs and LXC containers, commands inside them
- [docs/consoles.md](docs/consoles.md): VNC input, screenshots, screen matchers, the serial console
- [docs/shell.md](docs/shell.md): root shells, the policy, ZFS, systemd, apt, `qm`, `pct`
- [docs/cluster-and-nodes.md](docs/cluster-and-nodes.md): status, HA, membership, access control, node settings
- [docs/storage.md](docs/storage.md): definitions, volumes, local disks, backups
- [docs/networking.md](docs/networking.md): the staged interface edit, guest networks, the firewall, logs
- [docs/tasks-and-errors.md](docs/tasks-and-errors.md): UPIDs, waiting, status and logs, the error tree, tracing
- [docs/api-gaps.md](docs/api-gaps.md): what the API cannot do and the shell call that covers it
- [docs/property-strings.md](docs/property-strings.md): parsing and building config values
- [ARCHITECTURE.md](ARCHITECTURE.md): module dependencies, credential selection, wire values, error classes
- [SKILL.md](SKILL.md): the skill manifest

## Development

```sh
bun install
bun test
set -a; . ./pve.env; set +a; PVE_LIVE=1 PVE_ENV_FILE=./pve.env bun test test/live
bun run typecheck
bun run format
```

## Scope

Bun only. Ceph and SDN endpoints are not generated. Twelve endpoints and the
termproxy shell accept only a `root@pam` ticket; [docs/auth.md](docs/auth.md)
lists them.

## License

Apache-2.0

# pve-agent

Proxmox VE skill and Bun library for coding agents: API, consoles, guest
agent, node shells.

- 537 REST endpoints from a PVE 9.2 schema, typed parameters and privilege flags
- QEMU and LXC guests: lifecycle, config, snapshots, cloning, migration, firewall
- VNC keyboard, mouse and framebuffer; screenshots; screen matchers
- Serial consoles through a headless terminal, with login and prompt detection
- Commands inside a guest through the QEMU guest agent or `pct exec`
- Root shell on any node over SSH or termproxy, with ZFS, systemd, apt, `qm`
  and `pct` helpers and a policy that refuses destructive commands
- Property-string parsing and formatting from the same schema

## Install

As a dependency:

```sh
bun add github:paltaio/pve-agent
```

As a checkout:

```sh
git clone https://github.com/paltaio/pve-agent.git && cd pve-agent && bun install
```

The skill, from a checkout:

```sh
./install-pve-skill
```

The installer detects each agent CLI by its binary on PATH or its config
directory and copies the skill into the directory that CLI reads:

| CLI | Detected by | Skill directory |
| --- | --- | --- |
| Claude Code | `claude`, `~/.claude` | `~/.claude/skills` |
| Codex | `codex`, `~/.codex` | `~/.agents/skills` |
| OpenCode | `opencode`, `~/.config/opencode` | `~/.agents/skills` |
| Gemini CLI | `gemini`, `~/.gemini` | `~/.agents/skills` |
| Cursor | `agent`, `~/.cursor` | `~/.agents/skills` |
| GitHub Copilot CLI | `copilot`, `~/.copilot` | `~/.agents/skills` |
| Amp | `amp`, `~/.config/amp` | `~/.agents/skills` |
| Goose | `goose`, `~/.config/goose` | `~/.agents/skills` |
| Factory Droid | `droid`, `~/.factory` | `~/.agents/skills` |

`~/.agents/skills` is read by every CLI in the table except Claude Code, so
one copy there serves all of them. `PVE_SKILL_TARGETS=claude,codex,/some/skills`
picks targets by name or skills directory; `PVE_SKILL_LIST=1` prints the
targets and exits.

## Credentials

Environment variables, or a `pve.env` file:

```sh
PVE_HOST=192.0.2.10
PVE_PORT=8006
PVE_NODE=pve1
PVE_TOKEN_ID=automation@pve!ci
PVE_TOKEN_SECRET=...
PVE_USER=root@pam
PVE_PASSWORD=...
```

[docs/getting-started.md](docs/getting-started.md) has the resolution order
and the TLS note.

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

```sh
PVE_ENV_FILE=./pve.env bun run script.ts
```

## Documentation

- [docs/getting-started.md](docs/getting-started.md): install, credentials, the first calls
- [docs/auth.md](docs/auth.md): the token, the root ticket, root SSH, and how the client picks
- [docs/guests.md](docs/guests.md): QEMU VMs and LXC containers, commands inside them
- [docs/consoles.md](docs/consoles.md): VNC input, screenshots, screen matchers, the serial console
- [docs/shell.md](docs/shell.md): root shells, the policy, ZFS, systemd, apt, `qm`, `pct`
- [docs/cluster-and-nodes.md](docs/cluster-and-nodes.md): status, HA, membership, access control, node settings
- [docs/storage.md](docs/storage.md): definitions, volumes, local disks, backups
- [docs/networking.md](docs/networking.md): the staged interface edit, guest networks, the firewall
- [docs/tasks-and-errors.md](docs/tasks-and-errors.md): UPIDs, waiting, the error tree
- [docs/api-gaps.md](docs/api-gaps.md): what the API cannot do and the shell call that covers it
- [docs/property-strings.md](docs/property-strings.md): parsing and building config values
- [ARCHITECTURE.md](ARCHITECTURE.md): the internal contract
- [SKILL.md](SKILL.md): the skill manifest

Runnable scripts live in [examples/](examples/); each header names the
variables it reads.

## Development

```sh
bun install
bun test
set -a; . ./pve.env; set +a; PVE_LIVE=1 PVE_ENV_FILE=./pve.env bun test test/live
bun run typecheck
bun run format
```

`bun run schema root@<node>` dumps the schema from a node and `bun run
generate` rewrites `src/generated` from it.

## Scope

Bun only: the library uses Bun's `fetch`, `WebSocket` and `spawn`. Ceph and
SDN endpoints are not generated. Twelve endpoints and the termproxy shell
accept only a `root@pam` ticket; [docs/auth.md](docs/auth.md) lists them.

## License

Apache-2.0

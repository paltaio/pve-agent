# pve-agent documentation

Organised by what you came here to do. Every code block imports from
`pve-agent` and runs as written against a cluster whose credentials are in the
environment or a `pve.env` file.

## Start here

- [Getting started](getting-started.md): install, credentials, the first
  script, and the shape of the connected cluster object
- [Authentication tiers](auth.md): what a token reaches, what needs a
  `root@pam` ticket, what needs SSH, and how the client decides

## Guests

- [Guests](guests.md): creating, configuring and driving QEMU VMs and LXC
  containers, and running commands inside them
- [Consoles](consoles.md): keyboard, mouse and framebuffer over VNC;
  screenshots and screen matchers; the serial console

## The node

- [The shell layer](shell.md): root shells over SSH or termproxy, the command
  policy, and the ZFS, systemd, apt, `qm` and `pct` helpers
- [Cluster and nodes](cluster-and-nodes.md): status, resources, HA, corosync
  membership, users and ACLs, node settings
- [Storage](storage.md): storage definitions, volumes, local disks, backups
- [Networking](networking.md): the staged interface edit, guest networks, the
  firewall at all three levels

## When it goes wrong

- [Tasks and errors](tasks-and-errors.md): UPIDs, waiting, task logs, and each
  error class
- [What the API cannot do](api-gaps.md): the gaps, and the shell call that
  covers each

## Reference

- [Property strings](property-strings.md): parsing and building `net0`,
  `scsi0`, `mp0` and every other `key=value,key=value` config value
- [ARCHITECTURE.md](../ARCHITECTURE.md): the internal contract: module layout,
  the client, the generator, the consoles, the shell, the error tree

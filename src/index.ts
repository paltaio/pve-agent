/**
 * Connect once; every node, guest and console hangs off the cluster that
 * comes back.
 *
 * ```ts
 * import pve from 'pve-agent'
 *
 * await using cluster = await pve.connect()
 * const vm = await cluster.createVm({ node: 'ms01-0160', memory: '2048', scsi0: 'local-zfs:16' })
 * await vm.start()
 * await vm.kvm.type('root\n')
 * ```
 *
 * Every module underneath is exported by name for a caller that wants the
 * client, one API class or one helper on its own.
 */

import { connect } from './pve/cluster.ts'

export const pve = { connect }

export default pve

// The facade
export { connect, PveCluster } from './pve/cluster.ts'
export type {
	CreateContainerSpec,
	CreateVmSpec,
	PveClusterOptions,
	PveConnectOptions,
	PveVersion,
	ShellDefaults,
} from './pve/cluster.ts'
export { GuestConsole, VmKvm } from './pve/console.ts'
export type { PveContext, SerialOpenOptions } from './pve/context.ts'
export { PveContainer, PveVm } from './pve/guest.ts'
export type { PveGuest } from './pve/guest.ts'
export { PveNode } from './pve/node.ts'

// Core
export { loadCredentials, PveAuth } from './core/auth.ts'
export type {
	CredentialInput,
	PveConnection,
	PveCredentials,
	PveTicket,
	TicketCredential,
	TokenCredential,
} from './core/auth.ts'
export { encodeParams, PveClient, unwrapEnvelope } from './core/client.ts'
export type {
	EnvelopeResult,
	HttpMethod,
	PveClientOptions,
	PveParams,
	RawResponse,
	RequestOptions,
	RequestTrace,
	SignedRequest,
	TierDecision,
} from './core/client.ts'
export {
	GuestCommandError,
	GuestOutputTruncatedError,
	PveApiError,
	PveAuthError,
	PveConfigError,
	PveConnectionError,
	PveConsoleError,
	PveError,
	PveNotFoundError,
	PvePermissionError,
	PvePropertyError,
	PveShellError,
	PveTaskError,
	PveTierError,
	PveTimeoutError,
} from './core/errors.ts'
export type { AuthTier, PveErrorKind, ShellErrorKind } from './core/errors.ts'
export { HttpClient } from './core/http.ts'
export type { HttpBody, HttpClientOptions, HttpRequestOptions, HttpResponse } from './core/http.ts'
export { pollUntil, sleep } from './core/poll.ts'
export type { PollOptions } from './core/poll.ts'
export { ROOT_ONLY_PARAM_RULES, rootOnlyParams } from './core/privileges.ts'
export type { RootOnlyParamHit, RootOnlyParamRule } from './core/privileges.ts'
export {
	collapseIndexedKey,
	expandIndexedKey,
	formatPropertyString,
	formatSize,
	indexedKeyBase,
	isIndexedKey,
	parsePropertyString,
	parseSize,
	splitIndexedKey,
	splitPropertyParts,
} from './core/props.ts'
export type {
	FormatOptions,
	ParseOptions,
	PropertyBag,
	PropertyParts,
	PropertyScalar,
} from './core/props.ts'
export {
	formatConfigValue,
	parseConfigValue,
	propertyFormatFor,
	resolveEndpoint,
} from './core/schema.ts'
export {
	getTaskLog,
	getTaskStatus,
	isUpid,
	normalizeTaskListEntry,
	parseUpid,
	stopTask,
	taskOutcome,
	waitForTask,
} from './core/tasks.ts'
export type {
	ParsedUpid,
	PveLogLine,
	TaskListEntry,
	TaskLogOptions,
	TaskOutcome,
	TaskRunState,
	TaskStatus,
	WaitOptions,
} from './core/tasks.ts'
export {
	isRecord,
	parseBoolean,
	parseTagList,
	stringList,
	toBoolean,
	toOptionalBoolean,
	toOptionalInteger,
	toOptionalNumber,
	toOptionalString,
} from './core/values.ts'

// Generated registry and parameter types
export {
	DOCUMENTED_ROOT_ONLY_PARAMS,
	endpoints,
	ROOT_ONLY_ENDPOINTS,
	TOKEN_FORBIDDEN_ENDPOINTS,
} from './generated/endpoints.ts'
export type { EndpointInfo, EndpointKey, EndpointParam } from './generated/endpoints.ts'
export { propertyFormats, TYPETEXT_DERIVED_FORMATS } from './generated/formats.ts'
export type { PropertyFormat, PropertyFormatEntry } from './generated/formats.ts'
export type * from './generated/types.ts'

// Access control
export { AccessApi } from './access/access.ts'
export type {
	AccessApiOptions,
	AclEntry,
	ApiToken,
	ApiTokenSecret,
	AuthRealm,
	AuthTicket,
	EffectivePermissions,
	PveGroup,
	PveRole,
	PveUser,
	TfaAdded,
	TfaEntry,
	UserTfa,
} from './access/access.ts'

// Cluster
export { ClusterBackupApi } from './cluster/backup.ts'
export type {
	BackupIncludedVolume,
	BackupIncludedVolumes,
	BackupJob,
	BackupMode,
	UnbackedGuest,
} from './cluster/backup.ts'
export { ClusterBulkApi } from './cluster/bulk.ts'
export type {
	BulkMigrateParams,
	BulkShutdownParams,
	BulkStartParams,
	BulkSuspendParams,
} from './cluster/bulk.ts'
export { ClusterApi, nextVmid } from './cluster/cluster.ts'
export type {
	ClusterLogEntry,
	ClusterResource,
	ClusterStatusEntry,
	GuestLocation,
} from './cluster/cluster.ts'
export { envelopeTotal, getEnvelope } from './cluster/envelope.ts'
export {
	ClusterFirewallApi,
	FirewallRulesApi,
	normalizeFirewallIpsetEntry,
	normalizeFirewallRule,
} from './cluster/firewall.ts'
export type {
	FirewallAlias,
	FirewallIpset,
	FirewallIpsetEntry,
	FirewallMacro,
	FirewallOptions,
	FirewallOptionsParams,
	FirewallPolicy,
	FirewallRef,
	FirewallRule,
	FirewallRuleCreateParams,
	FirewallRuleUpdateParams,
	FirewallSecurityGroup,
} from './cluster/firewall.ts'
export { ClusterHaApi, normalizeHaRule } from './cluster/ha.ts'
export type {
	HaGroup,
	HaNodeAffinityRule,
	HaOtherRule,
	HaResource,
	HaResourceAffinityRule,
	HaRule,
	HaStatusEntry,
} from './cluster/ha.ts'
export { ClusterJobsApi } from './cluster/jobs.ts'
export type { RealmSyncJob, RealmSyncScope } from './cluster/jobs.ts'
export { ClusterMappingApi, MappingKindApi } from './cluster/mapping.ts'
export type { HardwareMapping, MappingKind } from './cluster/mapping.ts'
export { ClusterMembershipApi } from './cluster/membership.ts'
export type { ClusterJoinInfo, CorosyncNode, CorosyncTotem } from './cluster/membership.ts'
export { ClusterMetricsApi } from './cluster/metrics.ts'
export type { MetricServer, MetricsExport } from './cluster/metrics.ts'
export { ClusterNotificationsApi, NotificationEndpointApi } from './cluster/notifications.ts'
export type {
	NotificationEndpointKind,
	NotificationMatcher,
	NotificationTarget,
	NotificationTargetOrigin,
} from './cluster/notifications.ts'
export { PoolsApi } from './cluster/pools.ts'
export type {
	Pool,
	PoolCreateParams,
	PoolMember,
	PoolMemberType,
	PoolUpdateParams,
} from './cluster/pools.ts'
export { ClusterReplicationApi } from './cluster/replication.ts'
export type { ReplicationJob } from './cluster/replication.ts'
export { StorageConfigApi } from './cluster/storage.ts'
export type { StorageConfig, StorageType } from './cluster/storage.ts'

// Nodes
export { NodeAptApi } from './node/apt.ts'
export type { AptRepositories, AptRepositoryFile, AptUpdate, AptVersion } from './node/apt.ts'
export { NodeBackupApi } from './node/backup.ts'
export { NodeCertificatesApi } from './node/certificates.ts'
export type { CertificateInfo } from './node/certificates.ts'
export { NodeDisksApi } from './node/disks.ts'
export type {
	DirectoryStorage,
	DiskEntry,
	DiskType,
	LvmThinPool,
	LvmVolumeGroup,
	SmartAttribute,
	SmartHealth,
	ZpoolDetail,
	ZpoolSummary,
	ZpoolVdev,
} from './node/disks.ts'
export { NodeFirewallApi } from './node/firewall.ts'
export type { FirewallLogPage } from './node/firewall.ts'
export { NodeHardwareApi } from './node/hardware.ts'
export type { MdevType, PciDevice, UsbDevice } from './node/hardware.ts'
export { NodeNetworkApi } from './node/network.ts'
export type {
	NetworkInterface,
	NetworkInterfaceFilter,
	NetworkInterfaceType,
	StagedNetworkChanges,
} from './node/network.ts'
export { listNodes, NodeApi } from './node/node.ts'
export type {
	BatchCommand,
	BatchResult,
	NodeDnsSettings,
	NodeHostsFile,
	NodeListEntry,
	NodeStatus,
	NodeTimeSettings,
	NodeVersion,
} from './node/node.ts'
export { NodeReplicationApi } from './node/replication.ts'
export type { ReplicationLogPage, ReplicationStatus } from './node/replication.ts'
export { NodeScanApi } from './node/scan.ts'
export type {
	CifsShare,
	IscsiTarget,
	NfsExport,
	PbsDatastore,
	ScannedThinPool,
	ScannedVolumeGroup,
	ScannedZfsPool,
} from './node/scan.ts'
export { isNodeService, NODE_SERVICES, NodeServicesApi } from './node/services.ts'
export type { NodeService, ServiceEntry } from './node/services.ts'
export { NodeStorageApi } from './node/storage.ts'
export type {
	FileRestoreEntry,
	PruneCandidate,
	StorageStatus,
	StorageStatusEntry,
	StorageUploadParams,
	VolumeAttributes,
	VolumeEntry,
} from './node/storage.ts'
export { NodeTasksApi } from './node/tasks.ts'
export type { NodeTaskListOptions, NodeTaskPage } from './node/tasks.ts'

// Guests
export { QemuAgent } from './guest/agent.ts'
export type {
	AgentExecOptions,
	AgentExecResult,
	AgentExecStatus,
	AgentFileContent,
	AgentFilesystem,
	AgentIpAddress,
	AgentNetworkInterface,
	AgentOsInfo,
	AgentSetUserPasswordParams,
	AgentSimpleCommand,
	AgentUser,
} from './guest/agent.ts'
export {
	createContainer,
	createVm,
	findGuest,
	guestHandle,
	listGuests,
	openGuest,
	resolveGuest,
} from './guest/discovery.ts'
export type {
	CreateContainerSpec as CreateContainerParams,
	CreateVmSpec as CreateVmParams,
	ListGuestsOptions,
} from './guest/discovery.ts'
export { GuestFirewallApi } from './guest/firewall.ts'
export type {
	GuestFirewallAliasCreateParams,
	GuestFirewallAliasUpdateParams,
	GuestFirewallIpsetCreateParams,
	GuestFirewallIpsetEntryCreateParams,
	GuestFirewallIpsetEntryUpdateParams,
	GuestFirewallLogOptions,
	GuestFirewallOptionsParams,
	GuestFirewallRefsOptions,
} from './guest/firewall.ts'
export { destroyGuest, getStatus, powerAction, waitForRunState } from './guest/lifecycle.ts'
export type { PowerAction, WaitForStateOptions } from './guest/lifecycle.ts'
export { listContainers, LxcApi } from './guest/lxc.ts'
export type {
	LxcCloneParams,
	LxcDeleteParams,
	LxcInterface,
	LxcMigrateParams,
	LxcMoveVolumeParams,
	LxcRebootParams,
	LxcResizeParams,
	LxcRrdOptions,
	LxcShutdownParams,
	LxcSnapshotCreateParams,
	LxcSpiceProxyParams,
	LxcStartParams,
	LxcStopParams,
	LxcTermProxyParams,
	LxcVncProxyParams,
	LxcVolumeKey,
} from './guest/lxc.ts'
export { listVms, QemuApi } from './guest/qemu.ts'
export type {
	CloudinitDumpType,
	CloudinitPendingRow,
	QemuCloneParams,
	QemuDeleteParams,
	QemuDiskKey,
	QemuMigrateParams,
	QemuMoveDiskParams,
	QemuRebootParams,
	QemuResetParams,
	QemuResizeParams,
	QemuResumeParams,
	QemuRrdOptions,
	QemuShutdownParams,
	QemuSnapshotCreateParams,
	QemuSpiceProxyParams,
	QemuStartParams,
	QemuStopParams,
	QemuSuspendParams,
	QemuTemplateParams,
	QemuTermProxyParams,
	QemuUnlinkParams,
	QemuVncProxyParams,
} from './guest/qemu.ts'
export { GuestSnapshotsApi } from './guest/snapshots.ts'
export type { SnapshotDeleteOptions, SnapshotRollbackOptions } from './guest/snapshots.ts'
export {
	formatGuestConfigValue,
	guestPath,
	joinKeyList,
	normalizeFeature,
	normalizeLxcConfig,
	normalizeMigratePreconditions,
	normalizePending,
	normalizeQemuConfig,
	normalizeSnapshots,
	normalizeStatus,
	normalizeSummary,
	parseGuestConfigValue,
	toRunState,
} from './guest/types.ts'
export type {
	GuestConfig,
	GuestConfigOptions,
	GuestConfigValue,
	GuestFeature,
	GuestRef,
	GuestSnapshot,
	GuestStatus,
	GuestSummary,
	GuestType,
	LxcConfig,
	MigratePreconditions,
	PendingChange,
	QemuConfig,
	RrdPoint,
	RunState,
} from './guest/types.ts'

// Guest OS helpers
export { DarwinGuest } from './guest-os/darwin.ts'
export {
	checkResult,
	DEFAULT_TIMEOUT_MS,
	pctExecutor,
	qemuAgentExecutor,
} from './guest-os/executor.ts'
export {
	detectGuestOs,
	guestOsFor,
	guestOsFromOsInfo,
	guestOsFromOstype,
	hasMacosHint,
	openGuestOs,
	waitForAgent,
} from './guest-os/guest-os.ts'
export type { AnyGuestOs, OpenGuestOsOptions, WaitForAgentOptions } from './guest-os/guest-os.ts'
export { LinuxGuest } from './guest-os/linux.ts'
export { parseFields, PosixGuest } from './guest-os/posix.ts'
export type { PosixWriteFileOptions } from './guest-os/posix.ts'
export type {
	GuestExecutor,
	GuestOs,
	GuestOsInfo,
	GuestOsKind,
	GuestRunOptions,
	GuestRunResult,
} from './guest-os/types.ts'
export { psEncode, psQuote, WindowsGuest } from './guest-os/windows.ts'

// Consoles
export { desEncryptBlock, vncDesEncrypt } from './console/des.ts'
export {
	BYTES_PER_PIXEL,
	changedFraction,
	clampRegion,
	colorDistance,
	colorRatio,
	cropFrame,
	packRgb,
	parseColor,
	pixelAt,
	scaleFrame,
	toleranceFor,
} from './console/framebuffer.ts'
export type { Color, ColorRatioOptions, Region, Rgb } from './console/framebuffer.ts'
export { matchScreen, runMatcher, waitForScreen } from './console/match.ts'
export type {
	ChangedMatcher,
	ColorMatcher,
	MatcherResult,
	PixelMatcher,
	ScreenMatcher,
	ScreenMatchOptions,
	ScreenMatchResult,
	ScreenPredicate,
	ScreenWaitOptions,
} from './console/match.ts'
export {
	consoleAuthHeaders,
	consoleTier,
	consoleWebSocketUrl,
	guestBasePath,
	requestTermProxy,
	requestVncProxy,
} from './console/proxy.ts'
export type {
	SerialPort,
	TermProxyParams,
	TermProxyTicket,
	VncProxyTicket,
} from './console/proxy.ts'
export { inputFrames, KEEPALIVE_FRAME, loginFrame, resizeFrame, sendInput } from './console/pty.ts'
export {
	buildClientCutText,
	buildClientInit,
	buildFbUpdateRequest,
	buildKeyEvent,
	buildPointerEvent,
	buildSetEncodings,
	buildSetPixelFormat,
	charToKeysym,
	CLIENT_VERSION,
	MSG_BELL,
	MSG_CLIENT_CUT_TEXT,
	MSG_FB_UPDATE,
	MSG_FB_UPDATE_REQUEST,
	MSG_KEY_EVENT,
	MSG_POINTER_EVENT,
	MSG_SERVER_CUT_TEXT,
	MSG_SET_COLOUR_MAP,
	MSG_SET_ENCODINGS,
	MSG_SET_PIXEL_FORMAT,
	parseKeyCombo,
	parseProtocolVersion,
	parseRectangle,
	parseSecurityResult,
	parseSecurityTypes,
	parseServerInit,
	parseServerMessage,
	PIXEL_FORMAT,
	RFB_ENCODING_COPYRECT,
	RFB_ENCODING_DESKTOP_SIZE,
	RFB_ENCODING_RAW,
	SECURITY_NONE,
	SECURITY_VNC_AUTH,
	SHIFTED_CHARS,
	SPECIAL_KEYS,
} from './console/rfb.ts'
export type {
	Parsed,
	ParseResult,
	Rectangle,
	ScreenSize,
	ServerInit,
	ServerMessage,
} from './console/rfb.ts'
export { captureScreenshot, encodeScreenshot } from './console/screenshot.ts'
export type {
	CaptureOptions,
	Screenshot,
	ScreenshotFormat,
	ScreenshotOptions,
} from './console/screenshot.ts'
export { openWebSocket } from './console/socket.ts'
export type { ConsoleSocket, SocketFactory, SocketOptions } from './console/socket.ts'
export { keySequence, openSerialConsole, SerialConsole, SHELL_PROMPT } from './console/terminal.ts'
export type {
	PromptOptions,
	SerialConsoleEvents,
	SerialConsoleOptions,
	SerialKey,
	SerialWaitOptions,
} from './console/terminal.ts'
export { Framebuffer, POINTER_BUTTONS, VncSession } from './console/vnc.ts'
export type {
	FramebufferSnapshot,
	MouseButton,
	TypeOptions,
	VncScreenSize,
	VncSessionEvents,
	VncSessionOptions,
} from './console/vnc.ts'

// Root shells
export {
	PveShellCommandError,
	PveShellCredentialError,
	PveShellOutputError,
	PveShellPolicyError,
	PveShellTimeoutError,
	PveShellTransportError,
} from './shell/errors.ts'
export {
	assertPathSegment,
	assertSafeInteger,
	shHeredoc,
	shJoin,
	shQuote,
	shWrap,
} from './shell/escape.ts'
export type { ShellContext } from './shell/escape.ts'
export { parsePctDf, parsePctList, PctShell } from './shell/lxc.ts'
export type { PctDiskUsage, PctExecOptions, PctListEntry, PctTransferOptions } from './shell/lxc.ts'
export { NodeShell, selectTransport } from './shell/node-shell.ts'
export type { NodeShellOptions, TransportChoice } from './shell/node-shell.ts'
export {
	AptShell,
	parseAptList,
	parseAptPolicy,
	parseAptSimulation,
	parseStanzas,
} from './shell/packages.ts'
export type {
	AptChange,
	AptPolicy,
	AptSearchHit,
	AptUpgradable,
	InstalledPackage,
} from './shell/packages.ts'
export { CommandPolicy, commandPrograms, DESTRUCTIVE_PATTERNS } from './shell/policy.ts'
export type { DestructivePattern, PolicyDecision } from './shell/policy.ts'
export {
	parseGuestConfig,
	parseGuestExec,
	parseMonitorOutput,
	parseQmList,
	QmShell,
} from './shell/qemu.ts'
export type { ImportDiskOptions, QmGuestExecResult, QmListEntry } from './shell/qemu.ts'
export { spawnProcess } from './shell/spawn.ts'
export type { SpawnFn, SpawnRequest, SpawnResult } from './shell/spawn.ts'
export { probeSsh, SshTransport } from './shell/ssh.ts'
export type { SshOptions, SshProbe } from './shell/ssh.ts'
export { parseShowBlock, SystemdShell } from './shell/systemd.ts'
export type {
	JournalOptions,
	SystemdTimer,
	SystemdUnitRow,
	SystemdUnitStatus,
} from './shell/systemd.ts'
export { openTermproxy, TermproxyTransport } from './shell/termproxy.ts'
export type { TermproxyOptions } from './shell/termproxy.ts'
export type {
	CommandResult,
	RunOptions,
	ShellPattern,
	ShellPolicy,
	ShellTransport,
	ShellTransportKind,
} from './shell/types.ts'
export { parseDatasetRows, parseZpoolStatus, ZfsShell } from './shell/zfs.ts'
export type {
	CreateDatasetOptions,
	DestroyDatasetOptions,
	ImportPoolOptions,
	ListDatasetsOptions,
	ZfsDataset,
	ZfsDatasetType,
	ZpoolDevice,
	ZpoolListEntry,
	ZpoolStatus,
} from './shell/zfs.ts'

/**
 * Node certificates: what is installed, a manually supplied pair, and ACME.
 *
 * ACME account and plugin configuration is cluster-wide under
 * `/cluster/acme`. What is here is ordering and revoking the certificate for
 * one node, using the `acme` and `acmedomain[n]` entries in that node's config.
 */

import type { PveClient } from '../core/client.ts'
import type {
	NodesCertificatesCustomDeleteParams,
	NodesCertificatesCustomPostParams,
} from '../generated/types.ts'

export interface CertificateInfo extends Record<string, unknown> {
	filename?: string
	fingerprint?: string
	subject?: string
	issuer?: string
	/** Epoch seconds. */
	notbefore?: number
	/** Epoch seconds. */
	notafter?: number
	'public-key-type'?: string
	'public-key-bits'?: number
	san?: string[]
	pem?: string
}

export class NodeCertificatesApi {
	private readonly client: PveClient
	private readonly base: string

	constructor(client: PveClient, node: string) {
		this.client = client
		this.base = `/nodes/${encodeURIComponent(node)}/certificates`
	}

	/** The certificates the node serves, with subject, SANs and expiry. */
	async info(): Promise<CertificateInfo[]> {
		return this.client.get<CertificateInfo[]>(`${this.base}/info`)
	}

	/**
	 * Install a certificate chain, and its key unless the key is already on the
	 * node. `restart` reloads pveproxy so the new certificate is served at
	 * once, which drops open API connections. Returns the installed
	 * certificate's info.
	 */
	async setCustom(params: NodesCertificatesCustomPostParams): Promise<CertificateInfo> {
		return this.client.post<CertificateInfo>(`${this.base}/custom`, params)
	}

	/** Remove the manually installed certificate and fall back to the cluster CA's. */
	async deleteCustom(options?: NodesCertificatesCustomDeleteParams): Promise<void> {
		await this.client.delete<null>(`${this.base}/custom`, options)
	}

	/**
	 * Order a certificate from the ACME CA set in the node config. `force`
	 * orders one even when the current certificate is still valid. Returns a
	 * UPID.
	 */
	async orderAcme(options?: { force?: boolean }): Promise<string> {
		return this.client.post<string>(`${this.base}/acme/certificate`, options)
	}

	/** Renew the ACME certificate. Returns a UPID. */
	async renewAcme(options?: { force?: boolean }): Promise<string> {
		return this.client.put<string>(`${this.base}/acme/certificate`, options)
	}

	/** Revoke the ACME certificate at the CA. Returns a UPID. */
	async revokeAcme(): Promise<string> {
		return this.client.delete<string>(`${this.base}/acme/certificate`)
	}
}

/**
 * Asterisk adapter barrel.
 *
 * Everything the rest of the backend needs to talk to Asterisk:
 *
 *   ARI REST    -> createAriClient / getAriClient  (call control)
 *   ARI events  -> AriEventStream                  (inbound call notifications)
 *   AMI         -> AmiClient / getAmiClient        (PJSIP registration state)
 *
 * The contract types live in @/lib/telephony/contracts and are re-exported here
 * so a consumer can import the client and its types from one place.
 */

export type {
	AriClient,
	AriContinueTarget,
	AriCreateBridgeOptions,
	AriEvent,
	AriEventName,
	AriEventOf,
	AriOriginateOptions,
	AsteriskBridge,
	AsteriskCallerId,
	AsteriskChannel,
	AsteriskDialplanCep,
	AsteriskPlayback,
} from "@/lib/telephony/contracts";
export type {
	AmiActionResult,
	AmiClientOptions,
	AmiEvent,
	AmiPacket,
	PjsipContactInfo,
	PjsipEndpointInfo,
} from "./ami-client";
export {
	AmiActionError,
	AmiClient,
	getAmiClient,
} from "./ami-client";
export type { AriClientOptions } from "./ari-client";
export { AriRequestError, createAriClient, getAriClient } from "./ari-client";
export type {
	AriAnyEventHandler,
	AriDisconnectInfo,
	AriEventHandler,
	AriEventStreamOptions,
} from "./ari-events";
export { AriEventStream } from "./ari-events";
export type {
	SyncResult,
	TenantEndpointSpec,
	TenantTelephonySpec,
	TenantTrunkSpec,
} from "./tenant-config";
export {
	collectTenantTelephony,
	derivedSipPassword,
	ensureTenantRecordingDir,
	isSafeConfigValue,
	isTenantConfigLive,
	legacyTenantSlug,
	operatorWebSipIdentity,
	renderTenantDialplan,
	renderTenantPjsip,
	setTenantConfigLive,
	syncAsteriskTenantConfig,
	tenantContextsFor,
	tenantEndpointFor,
	tenantRecordingDir,
} from "./tenant-config";

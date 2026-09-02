import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
	BrowserAuditActor,
	BrowserAuditAuthorization,
	BrowserAuditDispatch,
	BrowserAuditEngine,
	BrowserAuditEngineOptions,
	BrowserAuditFileDocumentAuthority,
	BrowserAuditSnapshot,
	BrowserAuditTuple,
} from "./browser-audit";

export type BrowserAuditTerminalSnapshotLease = () => BrowserAuditSnapshot | undefined;
export type BrowserAuditTerminalSnapshotSink = (lease: BrowserAuditTerminalSnapshotLease) => unknown;

/** Frozen candidate data supplied to the internal Task authority; not directly executable. */
export interface BrowserAuditBindingInput {
	readonly dispatch: BrowserAuditDispatch;
	readonly actor: BrowserAuditActor;
	readonly spawn_id: string;
	readonly authorization: BrowserAuditAuthorization;
	readonly tuples: readonly BrowserAuditTuple[];
	readonly file_document_authority: BrowserAuditEngineOptions["file_document_authority"];
	readonly session_name?: string | null;
	/** Trusted host-only one-use sink. It is never projected into tool input or output. */
	readonly terminal_snapshot_sink?: BrowserAuditTerminalSnapshotSink;
}

export async function handoffBrowserAuditSnapshot(
	engine: BrowserAuditEngine,
	sink: BrowserAuditTerminalSnapshotSink | undefined,
	onConsumed?: () => void,
): Promise<boolean> {
	if (!sink) {
		await engine.invalidate();
		return false;
	}
	let consumed = false;
	try {
		const result = sink(() => {
			if (consumed) return undefined;
			consumed = true;
			const snapshot = engine.consumeSnapshot() ?? undefined;
			if (snapshot) onConsumed?.();
			return snapshot;
		});
		if (result !== null && typeof result === "object" && "then" in result && typeof result.then === "function") {
			await engine.invalidate();
			return false;
		}
		return true;
	} catch {
		await engine.invalidate();
		return false;
	}
}

/** The runner awaits this IIFE; its callback is armed before the browser primitive. */
export async function readPinnedBrowserAuditFile(
	authority: BrowserAuditFileDocumentAuthority,
	repositoryRoot: string,
): Promise<Uint8Array> {
	const filePath = fileURLToPath(authority.document_locator);
	const resolvedRoot = await fs.realpath(repositoryRoot);
	const resolvedPath = await fs.realpath(filePath);
	const relative = path.relative(resolvedRoot, resolvedPath);
	if (
		resolvedPath !== filePath ||
		relative === "" ||
		relative.startsWith(`..${path.sep}`) ||
		path.isAbsolute(relative)
	) {
		throw new Error("browser_audit: file document is not a direct repository-local path");
	}
	const handle = await fs.open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
	try {
		const before = await handle.stat();
		if (!before.isFile()) throw new Error("browser_audit: file document is not a regular file");
		const bytes = await handle.readFile();
		const after = await handle.stat();
		if (
			before.dev !== after.dev ||
			before.ino !== after.ino ||
			before.size !== after.size ||
			after.size !== bytes.byteLength
		) {
			throw new Error("browser_audit: file document changed while being captured");
		}
		const actual = createHash("sha256").update(bytes).digest("hex");
		if (actual !== authority.expected_sha256) throw new Error("browser_audit: file document SHA-256 mismatch");
		return new Uint8Array(bytes);
	} finally {
		await handle.close();
	}
}

export function buildBrowserAuditInterceptionCode(
	documentLocator: string,
	allowedOrigins: readonly string[],
	allowDocument: boolean,
	actionCode: string,
	pinnedDocumentBase64?: string,
): string {
	const document = JSON.stringify(documentLocator);
	const origins = JSON.stringify(allowedOrigins);
	return `(async () => {
const requestedDocument = ${document};
const requestedOrigins = Object.freeze(${origins});
const pinnedDocumentBase64 = ${JSON.stringify(pinnedDocumentBase64 ?? null)};
const allowDocument = ${allowDocument ? "true" : "false"};
const auditState = page.__browserAuditState || { violation: undefined, operation: undefined, guardsInstalled: false };
page.__browserAuditState = auditState;
const latch = reason => {
  if (!auditState.violation) auditState.violation = String(reason || "forbidden-channel");
};
const failIfLatched = async () => {
  let pageViolation;
  try { pageViolation = await page.evaluate(() => globalThis.__browserAuditPageViolation); } catch {}
  if (pageViolation) latch(pageViolation);
  if (auditState.violation) throw new Error("browser audit forbidden channel: " + auditState.violation);
};
await failIfLatched();
await page.setRequestInterception(true);
if (!auditState.guardsInstalled) {
	const denyGuard = request => {
    const operation = auditState.operation;
    const url = request.url();
    const isNavigation = typeof request.isNavigationRequest === "function" && request.isNavigationRequest();
    const resourceType = typeof request.resourceType === "function" ? request.resourceType() : "unknown";
    const originAllowed = (() => { try { return operation?.allowedOrigins.includes(new URL(url).origin) === true; } catch { return false; } })();
    let allowed = false;
    let violation = "unauthorized-subresource";
    if (!operation) {
      violation = "delayed-request";
    } else if (resourceType === "websocket" || resourceType === "eventsource") {
      violation = "websocket";
    } else if (resourceType === "ping") {
      violation = "beacon";
    } else if (isNavigation) {
      if (operation.allowDocument && !operation.documentSeen && resourceType === "document" && url === operation.documentLocator) {
        operation.documentSeen = true;
        allowed = true;
      } else {
        violation = operation.allowDocument ? "redirect" : "action-navigation";
      }
    } else if (operation.allowSubresources && originAllowed) {
      allowed = true;
    }
    if (allowed) {
      if (isNavigation && pinnedDocumentBase64 !== null) {
        request.respond({ status: 200, contentType: "text/html; charset=utf-8", body: Buffer.from(pinnedDocumentBase64, "base64") }).catch(error => latch("request-respond-failed:" + String(error)));
      } else {
        request.continue().catch(error => latch("request-continue-failed:" + String(error)));
      }
    } else {
      latch(violation);
      request.abort("blockedbyclient").catch(error => latch("request-abort-failed:" + String(error)));
    }
	};
	const targetGuard = target => {
    const type = target.type();
    if (type === "page" || type === "worker" || type === "service_worker" || type === "shared_worker") {
      latch(type === "page" ? "popup" : "worker");
      target.page().then(child => child?.close()).catch(error => latch("target-close-failed:" + String(error)));
    }
	};
	const popupGuard = popup => {
    latch("popup");
    popup.close().catch(error => latch("popup-close-failed:" + String(error)));
	};
	const workerGuard = worker => {
    latch("worker");
    Promise.resolve(worker.terminate?.()).catch(error => latch("worker-close-failed:" + String(error)));
	};
	const downloadGuard = download => {
    latch("download");
    Promise.resolve(download.cancel?.()).catch(error => latch("download-cancel-failed:" + String(error)));
	};
	page.on("request", denyGuard);
	page.on("popup", popupGuard);
	page.on("workercreated", workerGuard);
	page.on("download", downloadGuard);
	browser.on("targetcreated", targetGuard);
	await page.exposeFunction("__browserAuditLatch", reason => latch(reason));
	auditState.guardsInstalled = true;
  const installPageDeny = () => {
    const root = globalThis;
    const mark = reason => {
      if (!root.__browserAuditPageViolation) root.__browserAuditPageViolation = reason;
      try { void root.__browserAuditLatch?.(reason); } catch {}
    };
    const lock = (owner, key, value) => {
      try {
        Object.defineProperty(owner, key, { configurable: false, enumerable: false, writable: false, value });
        const descriptor = Object.getOwnPropertyDescriptor(owner, key);
        if (!descriptor || descriptor.configurable || descriptor.writable || descriptor.value !== value) throw new Error("guard not locked");
      } catch (error) {
        mark("page-guard-install-failed:" + String(error));
        throw error;
      }
    };
    lock(root, "open", function () { mark("popup"); return null; });
    lock(root, "Worker", function () { mark("worker"); throw new Error("browser audit denied Worker"); });
    lock(root, "SharedWorker", function () { mark("worker"); throw new Error("browser audit denied SharedWorker"); });
    lock(root, "WebSocket", function () { mark("websocket"); throw new Error("browser audit denied WebSocket"); });
    if ("WebTransport" in root) lock(root, "WebTransport", function () { mark("webtransport"); throw new Error("browser audit denied WebTransport"); });
    if ("RTCPeerConnection" in root) lock(root, "RTCPeerConnection", function () { mark("webrtc"); throw new Error("browser audit denied RTCPeerConnection"); });
    if ("webkitRTCPeerConnection" in root) lock(root, "webkitRTCPeerConnection", function () { mark("webrtc"); throw new Error("browser audit denied webkitRTCPeerConnection"); });
    if (root.navigator) {
      lock(root.navigator, "sendBeacon", function () { mark("beacon"); return false; });
      const serviceWorker = root.navigator.serviceWorker;
      if (serviceWorker) lock(serviceWorker, "register", function () { mark("service-worker"); return Promise.reject(new Error("browser audit denied service worker registration")); });
    }
  };
  await page.evaluateOnNewDocument(installPageDeny);
  await page.evaluate(installPageDeny);

  const currentTarget = page.target();
  const currentTargetId = currentTarget?._targetId || currentTarget?._targetInfo?.targetId;
  const forbiddenTarget = info => info && info.targetId !== currentTargetId && (info.type === "page" || info.type === "worker" || info.type === "service_worker" || info.type === "shared_worker");
  const browserSession = await browser.target().createCDPSession();
	auditState.browserSession = browserSession;
  browserSession.on("Target.targetCreated", event => {
    if (!forbiddenTarget(event.targetInfo)) return;
    latch(event.targetInfo.type === "page" ? "popup" : "worker");
    browserSession.send("Target.closeTarget", { targetId: event.targetInfo.targetId }).catch(error => latch("target-close-failed:" + String(error)));
  });
  browserSession.on("Target.attachedToTarget", event => {
    if (!forbiddenTarget(event.targetInfo)) return;
    latch(event.targetInfo.type === "page" ? "popup" : "worker");
    browserSession.send("Target.closeTarget", { targetId: event.targetInfo.targetId }).catch(error => latch("target-close-failed:" + String(error)));
  });
  browserSession.on("Browser.downloadWillBegin", () => latch("download"));
  await browserSession.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  await browserSession.send("Target.setDiscoverTargets", { discover: true });
  await browserSession.send("Browser.setDownloadBehavior", { behavior: "deny" });

  const pageSession = await page.createCDPSession();
	auditState.pageSession = pageSession;
  pageSession.on("Network.webSocketCreated", () => latch("websocket"));
  pageSession.on("Network.webSocketFrameSent", () => latch("websocket"));
  pageSession.on("Network.webSocketFrameReceived", () => latch("websocket"));
  pageSession.on("Network.webTransportCreated", () => latch("webtransport"));
  pageSession.on("Network.webTransportConnectionEstablished", () => latch("webtransport"));
  pageSession.on("Network.webTransportClosed", () => latch("webtransport"));
  pageSession.on("Page.downloadWillBegin", () => latch("download"));
  await pageSession.send("Network.enable");
  await pageSession.send("Page.enable");
  await pageSession.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
}
await failIfLatched();
const operation = { documentLocator: requestedDocument, allowedOrigins: requestedOrigins, allowDocument, allowSubresources: allowDocument, documentSeen: false };
auditState.operation = operation;
const closeInitialResourceWindow = () => { operation.allowSubresources = false; };
if (allowDocument) page.once("load", closeInitialResourceWindow);
try {
  const result = await (async () => { ${actionCode} })();
  closeInitialResourceWindow();
  await new Promise(resolve => setTimeout(resolve, 0));
  await failIfLatched();
  return result;
} finally {
  closeInitialResourceWindow();
  auditState.operation = undefined;
  if (allowDocument) page.off("load", closeInitialResourceWindow);
}
})()`;
}

export function buildBrowserAuditViewportCode(viewport: BrowserAuditAuthorization["viewports"][number]): string {
	return `await page.setViewport(${JSON.stringify({
		width: viewport.width,
		height: viewport.height,
		deviceScaleFactor: viewport.device_scale_factor,
	})});`;
}

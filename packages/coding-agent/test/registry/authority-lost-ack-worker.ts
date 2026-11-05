import { parentPort } from "node:worker_threads";
import { AuthorityEngine } from "../../src/registry/authority/engine";
import type { MutationReceipt } from "../../src/registry/authority/types";
import { runAuthorityWorker } from "../../src/registry/authority/worker";

interface LostAckDiagnostic {
	readonly phase: "worker-started" | "transition-entered" | "durable-transition-returned" | "fault-thrown";
	readonly requestId?: string;
	readonly receipt?: MutationReceipt;
	readonly failure?: { readonly name: string; readonly message: string; readonly unknownOutcome: boolean };
}

if (!parentPort) throw new Error("Authority lost-ACK test worker requires a parent port");

const diagnosticChannel = new BroadcastChannel("omp-authority-lost-ack-diagnostic");
function reportDiagnostic(event: LostAckDiagnostic): void {
	diagnosticChannel.postMessage(event);
}

let committedReceipt: MutationReceipt | undefined;
const transition = AuthorityEngine.prototype.transition;
AuthorityEngine.prototype.transition = function (...args) {
	const requestId = args[1]?.requestId;
	if (requestId === "lost-ack-request") reportDiagnostic({ phase: "transition-entered", requestId });
	const receipt = Reflect.apply(transition, this, args) as MutationReceipt;
	if (requestId === "lost-ack-request") {
		committedReceipt = receipt;
		reportDiagnostic({ phase: "durable-transition-returned", requestId, receipt });
		const failure = new Error("Injected authority worker ACK loss after durable commit before response delivery");
		Object.assign(failure, { unknownOutcome: true, committedReceipt });
		reportDiagnostic({
			phase: "fault-thrown",
			requestId,
			failure: { name: failure.name, message: failure.message, unknownOutcome: true },
		});
		throw failure;
	}
	return receipt;
};
reportDiagnostic({ phase: "worker-started" });
void runAuthorityWorker();

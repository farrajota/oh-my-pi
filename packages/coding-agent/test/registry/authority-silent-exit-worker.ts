import { AuthorityEngine } from "../../src/registry/authority/engine";
import { runAuthorityWorker } from "../../src/registry/authority/worker";

// A worker that exits without an error event or a response while executing one specific request, as a
// native crash or an unexpected process.exit() inside the worker would.
const transition = AuthorityEngine.prototype.transition;
AuthorityEngine.prototype.transition = function (...args) {
	if (args[1]?.requestId === "silent-exit") process.exit(0);
	return Reflect.apply(transition, this, args);
};
void runAuthorityWorker();

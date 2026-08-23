(() => {
	"use strict";
	const PAYLOAD_ID = "approval-dossier-protected-state";
	const PAYLOAD_ENCODING = "base64-canonical-json";
	const statusText = {
		draft: "Save response",
		"changes-requested": "Request changes",
		approved: "Approve dossier",
		rejected: "Reject dossier",
	};

	function decodeBase64Utf8(encoded) {
		if (typeof encoded !== "string" || encoded.length === 0 || encoded !== encoded.trim() || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new TypeError("protected approval payload encoding is invalid");
		const binary = atob(encoded);
		const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
		const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		if (base64Utf8(decoded) !== encoded) throw new TypeError("protected approval payload encoding is not canonical UTF-8");
		return decoded;
	}

	function decodePayload(element) {
		if (!(element instanceof HTMLTemplateElement) || element.dataset.approvalDossierEncoding !== PAYLOAD_ENCODING) throw new TypeError("protected approval payload is unavailable");
		return JSON.parse(decodeBase64Utf8(element.content.textContent));
	}

	function base64Utf8(value) {
		const bytes = new TextEncoder().encode(value);
		let binary = "";
		for (const byte of bytes) binary += String.fromCharCode(byte);
		return btoa(binary);
	}

	function trimmedText(control, name) {
		const value = control.value;
		if (value.trim().length === 0) throw new TypeError(`${name} is required`);
		if (new TextEncoder().encode(value).byteLength > 4_096) throw new TypeError(`${name} exceeds 4,096 UTF-8 bytes`);
		return value;
	}

	function feedbackTarget(encoded) {
		const target = JSON.parse(decodeBase64Utf8(encoded));
		if (!target || typeof target !== "object" || Array.isArray(target)) throw new TypeError("feedback target is invalid");
		const keys = Object.keys(target).sort();
		const expected = (names) => keys.length === names.length && keys.every((key, index) => key === names[index]);
		if (target.target_type === "semantic-id" && expected(["semantic_id", "target_type"]) && typeof target.semantic_id === "string" && target.semantic_id.trim().length > 0) return target;
		if (target.target_type === "markdown-path" && expected(["markdown_path", "target_type"]) && typeof target.markdown_path === "string" && target.markdown_path.length > 0 && !target.markdown_path.startsWith("/") && !target.markdown_path.includes("\\") && !target.markdown_path.split("/").includes("..")) return target;
		if (target.target_type === "dossier" && expected(["target_type"])) return target;
		throw new TypeError("feedback target is invalid");
	}

	function evidenceIds(control) {
		const source = control.value.trim();
		if (source.length === 0) return [];
		const ids = source.split(",").map((value) => value.trim());
		if (ids.some((value) => !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value))) throw new TypeError("evidence IDs must be comma-separated stable identifiers");
		const unique = [...new Set(ids)].sort();
		if (unique.length > 128) throw new TypeError("feedback has too many evidence IDs");
		return unique;
	}

	function collectFeedback(dispositions) {
		const feedback = [];
		for (const item of document.querySelectorAll("[data-feedback-target]")) {
			if (item.dataset.feedbackId && dispositions.get(item.dataset.feedbackId) !== "edit" && dispositions.get(item.dataset.feedbackId) !== "proposal") continue;
			const kind = item.querySelector("[data-feedback-kind]");
			const requested = item.querySelector("[data-feedback-requested-change]");
			const rationale = item.querySelector("[data-feedback-rationale]");
			const evidence = item.querySelector("[data-feedback-evidence-ids]");
			if (!(kind instanceof HTMLSelectElement) || !(requested instanceof HTMLTextAreaElement) || !(rationale instanceof HTMLTextAreaElement) || !(evidence instanceof HTMLInputElement)) throw new TypeError("feedback controls are unavailable");
			const required = item.querySelector("[data-feedback-required]");
			const missingRequired = requested.value.trim().length === 0 || rationale.value.trim().length === 0;
			if (required instanceof HTMLElement) required.hidden = !missingRequired;
			if (kind.value !== "edit" && kind.value !== "proposal") throw new TypeError("feedback kind is invalid");
			const feedbackId = item.getAttribute("data-feedback-id");
			const target = item.getAttribute("data-feedback-target");
			if (!feedbackId || !/^feedback-[0-9]{4}$/.test(feedbackId) || !target) throw new TypeError("feedback identity is invalid");
			feedback.push({ evidence_ids: evidenceIds(evidence), feedback_id: feedbackId, kind: kind.value, rationale: trimmedText(rationale, "rationale"), requested_change: trimmedText(requested, "requested change"), target: feedbackTarget(target) });
		}
		feedback.sort((left, right) => left.feedback_id < right.feedback_id ? -1 : left.feedback_id > right.feedback_id ? 1 : 0);
		if (feedback.length > 128 || feedback.some((item, index) => index > 0 && item.feedback_id === feedback[index - 1].feedback_id)) throw new TypeError("feedback identities must be unique");
		return feedback;
	}

	function hydrateFeedbackControls(response, dispositions) {
		if (!response || !Array.isArray(response.feedback)) return;
		for (const feedback of response.feedback) {
			if (!feedback || typeof feedback !== "object" || typeof feedback.feedback_id !== "string" || typeof feedback.kind !== "string" || typeof feedback.requested_change !== "string" || typeof feedback.rationale !== "string" || !Array.isArray(feedback.evidence_ids)) continue;
			for (const item of document.querySelectorAll("[data-feedback-target]")) {
				if (item.getAttribute("data-feedback-id") !== feedback.feedback_id || item.getAttribute("data-feedback-target") === null) continue;
				const kind = item.querySelector("[data-feedback-kind]");
				const requested = item.querySelector("[data-feedback-requested-change]");
				const rationale = item.querySelector("[data-feedback-rationale]");
				const evidence = item.querySelector("[data-feedback-evidence-ids]");
				if (!(kind instanceof HTMLSelectElement) || !(requested instanceof HTMLTextAreaElement) || !(rationale instanceof HTMLTextAreaElement) || !(evidence instanceof HTMLInputElement)) continue;
				try {
					if ((feedback.kind !== "edit" && feedback.kind !== "proposal") || base64Utf8(JSON.stringify(feedback.target)) !== item.getAttribute("data-feedback-target")) continue;
					evidence.value = feedback.evidence_ids.join(", ");
					kind.value = feedback.kind;
					requested.value = feedback.requested_change;
					rationale.value = feedback.rationale;
					dispositions.set(feedback.feedback_id, feedback.kind);
				} catch { continue; }
			}
		}
	}

	function filename(response, status) {
		const stem = `${response.candidate.workflow}-${response.candidate.run_id}-r${String(response.candidate.revision).padStart(4, "0")}`.replace(/[^A-Za-z0-9._-]/g, "-");
		return `${stem}-${status}-${response.candidate_sha256.slice(0, 12)}.html`;
	}

	function button(label, action, tone) {
		const control = document.createElement("button");
		control.type = "button";
		control.dataset.action = action;
		control.textContent = label;
		if (tone) control.className = tone;
		return control;
	}

	function clearEditor(editor) {
		for (const control of editor.querySelectorAll("textarea, input")) control.value = "";
		const kind = editor.querySelector("[data-feedback-kind]");
		if (kind instanceof HTMLSelectElement) kind.value = "edit";
	}

	function hydrate() {
		const payload = document.getElementById(PAYLOAD_ID);
		const shell = document.getElementById("approval-dossier-controls");
		if (!payload || !shell) return;
		let response;
		try { response = decodePayload(payload); } catch { return; }
		const initialSource = `<!doctype html>\n${document.documentElement.outerHTML}`;
		const sourceMarker = `<template id="${PAYLOAD_ID}" data-approval-dossier-encoding="${PAYLOAD_ENCODING}">`;
		if (!initialSource.includes(sourceMarker)) return;

		const dispositions = new Map();
		const queueButtons = [...document.querySelectorAll("[data-review-select]")];
		const summaries = [...document.querySelectorAll("[data-review-summary]")];
		const editors = [...document.querySelectorAll("[data-feedback-editor]")];
		const mobileTabs = [...document.querySelectorAll("[data-mobile-review-tab]")];
		const mobilePanes = [...document.querySelectorAll("[data-review-pane]")];
		const progressCurrent = document.querySelector("[data-progress-current]");
		const queueSearch = document.querySelector("[data-review-search]");
		const sourceDrawer = document.querySelector(".source-drawer");
		const anchorNav = document.querySelector(".anchor-nav");

		function syncStickyOffsets() {
			if (!(anchorNav instanceof HTMLElement)) return;
			document.documentElement.style.setProperty("--anchor-nav-height", `${anchorNav.getBoundingClientRect().height}px`);
		}
		let activeId = queueButtons[0] instanceof HTMLButtonElement ? queueButtons[0].dataset.reviewSelect : undefined;
		let activeMobilePanel = "queue";
		let unresolvedOnly = false;
		let pendingAction = "";

		hydrateFeedbackControls(response, dispositions);
		if (response.approval_status === "approved") for (const editor of editors) if (editor instanceof HTMLElement && editor.dataset.feedbackId) dispositions.set(editor.dataset.feedbackId, "accepted");

		const status = document.createElement("p");
		status.className = "status-line";
		status.setAttribute("aria-live", "polite");
		status.textContent = "Review controls ready. Protected Markdown and candidate bindings cannot be edited here.";
		const actionRow = document.createElement("div");
		actionRow.className = "control-row";
		for (const state of ["draft", "changes-requested", "rejected", "approved"]) actionRow.append(button(statusText[state], state, state === "approved" ? "primary" : state === "rejected" ? "danger" : ""));
		const utilityRow = document.createElement("div");
		utilityRow.className = "control-row";
		const sourceToggle = button("Open source drawer", "source");
		sourceToggle.setAttribute("aria-expanded", "false");
		if (sourceDrawer instanceof HTMLDetailsElement) sourceToggle.setAttribute("aria-controls", sourceDrawer.id);
		utilityRow.append(sourceToggle);
		const note = document.createElement("p");
		note.className = "metadata";
		note.textContent = "Item drafts stay in this page while you navigate. Only saved typed feedback becomes approval authority.";
		shell.replaceChildren(note, utilityRow, actionRow, status);

		const unresolvedToggle = button("Show unresolved only", "unresolved");
		unresolvedToggle.setAttribute("aria-pressed", "false");
		if (queueSearch instanceof HTMLInputElement && queueSearch.parentElement && queueSearch.parentElement.parentElement) queueSearch.parentElement.parentElement.insertBefore(unresolvedToggle, queueSearch.parentElement.nextSibling);

		function editorFor(id) {
			return editors.find((editor) => editor instanceof HTMLElement && editor.dataset.feedbackEditor === id);
		}

		function queueButtonFor(id) {
			return queueButtons.find((control) => control instanceof HTMLButtonElement && control.dataset.reviewSelect === id);
		}

		function feedbackIsComplete(editor) {
			if (!(editor instanceof HTMLElement) || (editor.dataset.disposition !== "edit" && editor.dataset.disposition !== "proposal")) return false;
			const requested = editor.querySelector("[data-feedback-requested-change]");
			const rationale = editor.querySelector("[data-feedback-rationale]");
			return requested instanceof HTMLTextAreaElement && rationale instanceof HTMLTextAreaElement && requested.value.trim().length > 0 && rationale.value.trim().length > 0;
		}

		function validConditionalFeedback() {
			try { return collectFeedback(dispositions); } catch { return null; }
		}

		function syncActionGates() {
			const complete = dispositions.size === editors.length;
			const feedback = validConditionalFeedback();
			const hasFeedbackDispositions = [...dispositions.values()].some((value) => value === "edit" || value === "proposal");
			for (const action of actionRow.querySelectorAll("[data-action]")) {
				if (!(action instanceof HTMLButtonElement)) continue;
				action.disabled = action.dataset.action === "approved" && (!complete || hasFeedbackDispositions);
				if (action.dataset.action === "changes-requested") action.disabled = feedback === null || feedback.length === 0;
			}
		}

		function resetPendingAction() {
			pendingAction = "";
			for (const action of actionRow.querySelectorAll("[data-action]")) {
				if (action instanceof HTMLButtonElement && action.dataset.action) action.textContent = statusText[action.dataset.action] || "Save response";
			}
		}

		function syncDisposition(id) {
			const disposition = dispositions.get(id);
			const summary = summaries.find((entry) => entry instanceof HTMLElement && entry.dataset.reviewSummary === id);
			const editor = editorFor(id);
			if (!(summary instanceof HTMLElement) || !(editor instanceof HTMLElement)) return;
			for (const control of summary.querySelectorAll("[data-item-disposition]")) {
				if (!(control instanceof HTMLButtonElement)) continue;
				const selected = control.dataset.itemDisposition === disposition;
				control.setAttribute("aria-pressed", String(selected));
				control.dataset.active = String(selected);
			}
			const open = disposition === "edit" || disposition === "proposal";
			const fields = editor.querySelector("[data-feedback-fields]");
			const prompt = editor.querySelector("[data-feedback-prompt]");
			const kind = editor.querySelector("[data-feedback-kind]");
			if (fields instanceof HTMLElement) fields.hidden = !open;
			if (prompt instanceof HTMLElement) prompt.hidden = open;
			if (kind instanceof HTMLSelectElement && open) kind.value = disposition;
			editor.dataset.disposition = disposition || "";
			const noteLine = summary.querySelector("[data-item-note]");
			if (noteLine) noteLine.textContent = disposition === "accepted" ? "Marked no change." : disposition === "edit" ? "Edit requested. Complete the response fields in Reviewer input." : disposition === "proposal" ? "Proposal selected. Complete the response fields in Reviewer input." : "Choose a disposition. Edit and proposal open the reviewer-input pane.";
			const queueButton = queueButtonFor(id);
			const queueState = queueButton ? queueButton.querySelector("[data-item-state]") : null;
			if (queueState) queueState.textContent = disposition === "accepted" ? "Reviewed" : disposition === "edit" ? "Edit" : disposition === "proposal" ? "Proposal" : editor.dataset.unresolved === "true" ? "Open" : "Ready";
			syncActionGates();
		}

		function tabsAreOperable() {
			return mobileTabs.some((tab) => tab instanceof HTMLElement && tab.getClientRects().length > 0);
		}

		function syncTabSemantics() {
			const operable = tabsAreOperable();
			const tablist = document.querySelector(".mobile-review-tabs");
			if (tablist instanceof HTMLElement) {
				if (operable) tablist.setAttribute("role", "tablist");
				else tablist.removeAttribute("role");
			}
			for (const tab of mobileTabs) if (tab instanceof HTMLButtonElement) {
				if (operable) { tab.setAttribute("role", "tab"); tab.setAttribute("aria-controls", `review-pane-${tab.dataset.mobileReviewTab}`); }
				else { tab.removeAttribute("role"); tab.removeAttribute("aria-controls"); tab.removeAttribute("aria-selected"); tab.removeAttribute("tabindex"); }
			}
			for (const pane of mobilePanes) if (pane instanceof HTMLElement) {
				if (operable) { pane.setAttribute("role", "tabpanel"); pane.setAttribute("aria-labelledby", `mobile-review-tab-${pane.dataset.reviewPane}`); }
				else { pane.removeAttribute("role"); pane.removeAttribute("aria-labelledby"); pane.hidden = false; }
			}
			return operable;
		}

		function selectMobilePanel(name, focusTab) {
			activeMobilePanel = name;
			const tabsVisible = syncTabSemantics();
			for (const tab of mobileTabs) {
				if (!(tab instanceof HTMLButtonElement)) continue;
				const selected = tab.dataset.mobileReviewTab === name;
				if (tabsVisible) { tab.setAttribute("aria-selected", String(selected)); tab.tabIndex = selected ? 0 : -1; }
				if (selected && focusTab && tabsVisible) tab.focus();
			}
			for (const pane of mobilePanes) if (pane instanceof HTMLElement) pane.hidden = tabsVisible && pane.dataset.reviewPane !== name;
		}

		function selectItem(id, moveToReview) {
			if (!id || !editorFor(id)) return;
			activeId = id;
			for (const control of queueButtons) if (control instanceof HTMLButtonElement) control.setAttribute("aria-current", String(control.dataset.reviewSelect === id ? "step" : "false"));
			for (const summary of summaries) if (summary instanceof HTMLElement) summary.hidden = summary.dataset.reviewSummary !== id;
			for (const editor of editors) if (editor instanceof HTMLElement) editor.hidden = editor.dataset.feedbackEditor !== id;
			const index = queueButtons.findIndex((control) => control instanceof HTMLButtonElement && control.dataset.reviewSelect === id);
			if (progressCurrent) progressCurrent.textContent = String(index + 1);
			syncDisposition(activeId);
			if (moveToReview) selectMobilePanel("review", true);
		}

		function applyQueueFilter() {
			const query = queueSearch instanceof HTMLInputElement ? queueSearch.value.trim().toLowerCase() : "";
			let matched = 0;
			for (const control of queueButtons) {
				if (!(control instanceof HTMLButtonElement)) continue;
				const editor = editorFor(control.dataset.reviewSelect);
				const matchesQuery = !query || (control.dataset.searchText || "").includes(query);
				const matchesUnresolved = !unresolvedOnly || (editor instanceof HTMLElement && editor.dataset.unresolved === "true");
				const visible = matchesQuery && matchesUnresolved;
				control.classList.toggle("is-filtered", !visible);
				if (visible) matched += 1;
			}
			status.textContent = `${matched} review item${matched === 1 ? "" : "s"} shown.`;
		}

		for (const control of queueButtons) control.addEventListener("click", () => { if (control instanceof HTMLButtonElement) selectItem(control.dataset.reviewSelect, true); });
		for (const summary of summaries) {
			summary.addEventListener("click", (event) => {
				const target = event.target;
				if (!(target instanceof HTMLButtonElement) || !target.dataset.itemDisposition || !activeId) return;
				const disposition = target.dataset.itemDisposition;
				if (disposition !== "accepted" && disposition !== "edit" && disposition !== "proposal") return;
				dispositions.set(activeId, disposition);
				syncDisposition(activeId);
				resetPendingAction();
				status.textContent = disposition === "accepted" ? "Item marked no change." : disposition === "edit" ? "Edit requested; complete Reviewer input." : "Proposal selected; complete Reviewer input.";
				if (disposition === "edit" || disposition === "proposal") selectMobilePanel("feedback", true);
			});
		}

		for (const editor of editors) {
			const clear = editor.querySelector("[data-clear-feedback]");
			if (!(clear instanceof HTMLButtonElement)) continue;
			clear.addEventListener("click", () => {
				const id = editor instanceof HTMLElement ? editor.dataset.feedbackId : undefined;
				if (!id) return;
				clearEditor(editor);
				dispositions.set(id, "accepted");
				syncDisposition(id);
				resetPendingAction();
				status.textContent = "Feedback cleared; item marked no change.";
				selectMobilePanel("review", true);
			});
		}

		for (const editor of editors) {
			for (const control of editor.querySelectorAll("textarea, input, select")) control.addEventListener("input", () => { resetPendingAction(); syncActionGates(); });
			for (const control of editor.querySelectorAll("textarea, input, select")) control.addEventListener("change", () => { resetPendingAction(); syncActionGates(); });
		}

		if (queueSearch instanceof HTMLInputElement) queueSearch.addEventListener("input", applyQueueFilter);
		unresolvedToggle.addEventListener("click", () => {
			unresolvedOnly = !unresolvedOnly;
			unresolvedToggle.setAttribute("aria-pressed", String(unresolvedOnly));
			unresolvedToggle.textContent = unresolvedOnly ? "Show all review items" : "Show unresolved only";
			applyQueueFilter();
		});

		for (const tab of mobileTabs) {
			if (!(tab instanceof HTMLButtonElement)) continue;
			tab.addEventListener("click", () => selectMobilePanel(tab.dataset.mobileReviewTab, false));
			tab.addEventListener("keydown", (event) => {
				const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
				if (!keys.includes(event.key)) return;
				const visibleTabs = mobileTabs.filter((candidate) => candidate instanceof HTMLButtonElement && candidate.getClientRects().length > 0);
				const current = visibleTabs.indexOf(tab);
				if (current < 0) return;
				event.preventDefault();
				const next = event.key === "Home" ? 0 : event.key === "End" ? visibleTabs.length - 1 : event.key === "ArrowRight" ? (current + 1) % visibleTabs.length : (current - 1 + visibleTabs.length) % visibleTabs.length;
				const nextTab = visibleTabs[next];
				if (nextTab instanceof HTMLButtonElement) selectMobilePanel(nextTab.dataset.mobileReviewTab, true);
			});
		}

		window.addEventListener("resize", () => { syncStickyOffsets(); selectMobilePanel(activeMobilePanel, false); });
		sourceToggle.addEventListener("click", () => {
			if (!(sourceDrawer instanceof HTMLDetailsElement)) return;
			sourceDrawer.open = !sourceDrawer.open;
			sourceToggle.setAttribute("aria-expanded", String(sourceDrawer.open));
			sourceToggle.textContent = sourceDrawer.open ? "Close source drawer" : "Open source drawer";
			if (sourceDrawer.open) sourceDrawer.scrollIntoView({ block: "start" });
		});

		actionRow.addEventListener("click", (event) => {
			const target = event.target;
			if (!(target instanceof HTMLButtonElement) || !target.dataset.action || target.disabled) return;
			const approvalStatus = target.dataset.action;
			try {
				if (approvalStatus === "approved" && dispositions.size !== editors.length) throw new TypeError(`approval requires reviewing all ${editors.length} bounded items`);
				const feedback = collectFeedback(dispositions);
				if (approvalStatus === "changes-requested" && feedback.length === 0) throw new TypeError("changes requested requires at least one feedback item");
				if (approvalStatus === "approved" && feedback.length !== 0) throw new TypeError("approval requires all feedback to be cleared");
				if (approvalStatus !== "draft" && pendingAction !== approvalStatus) {
					resetPendingAction();
					pendingAction = approvalStatus;
					target.textContent = `Confirm ${statusText[approvalStatus].toLocaleLowerCase()}`;
					status.textContent = "Review the selected final action, then activate it again to save the bound response.";
					return;
				}
				const next = { ...response, approval_status: approvalStatus, approved_at: approvalStatus === "approved" ? response.submitted_at : null, feedback };
				const encoded = base64Utf8(JSON.stringify(next));
				const start = initialSource.indexOf(sourceMarker);
				const end = initialSource.indexOf("</template>", start);
				if (start < 0 || end < 0) throw new TypeError("protected payload marker is unavailable");
				const saved = `${initialSource.slice(0, start + sourceMarker.length)}${encoded}${initialSource.slice(end)}`;
				const objectUrl = URL.createObjectURL(new Blob([saved], { type: "text/html;charset=utf-8" }));
				const link = document.createElement("a");
				link.href = objectUrl;
				link.download = filename(response, approvalStatus);
				link.hidden = true;
				document.body.append(link);
				link.click();
				link.remove();
				URL.revokeObjectURL(objectUrl);
				resetPendingAction();
				status.textContent = `Saved ${filename(response, approvalStatus)}. The saved response preserves protected Markdown bytes and candidate/runtime bindings.`;
			} catch (error) {
				resetPendingAction();
				status.textContent = `Response not saved: ${error instanceof Error ? error.message : "invalid feedback"}.`;
			}
		});

		for (const editor of editors) if (editor instanceof HTMLElement && editor.dataset.feedbackId) syncDisposition(editor.dataset.feedbackId);
		syncStickyOffsets();
		if (activeId) selectItem(activeId, false);
		selectMobilePanel(activeMobilePanel, false);
		syncActionGates();
	}

	if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", hydrate, { once: true });
	else hydrate();
})();

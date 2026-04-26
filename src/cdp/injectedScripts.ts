/// <reference lib="dom" />

/** IPC binding name used for observer → Node.js communication. */
export const BINDING_NAME = '__aaDetect';

/**
 * The MutationObserver script injected once per webview session.
 *
 * Design:
 * - Single-pass O(D) TreeWalker scan — checks all keywords per node
 * - Priority-aware matching: run > accept > always allow > allow > retry > continue
 * - Word-boundary matching via startsWith + boundary check
 * - Per-element 5s cooldown via `data-aa-t` timestamp
 * - Webview Guard: deferred `.react-app-container` check on each scan
 * - 100ms leading-edge throttle to prevent CPU spikes during streaming
 * - Calls `__aaDetect(JSON.stringify(results))` to send data back to Node.js
 */
export function buildObserverScript(dangerousCommands: string[]): string {
	function injectedObserver(bindingName: string, dangerousCommandsList: string[]) {
		// Guard: don't inject twice
		if ((window as any).__AA_OBSERVER_ACTIVE) return 'already_injected';

		const COOLDOWN_MS = 5000;
		const RETRY_COOLDOWN_MS = 15000;
		const THROTTLE_MS = 100;
		const DANGEROUS = dangerousCommandsList;

		let throttleTimer: any = null;

		// Emergency stop: auto-pause if too many retry detections in a short window
		let retryDetectCount = 0;
		let retryDetectWindowStart = 0;
		const EMERGENCY_WINDOW_MS = 60000;
		const EMERGENCY_THRESHOLD = 5;

		// Word-boundary check: ensures "run" doesn't match "runtime"
		function startsWithWord(text: string, keyword: string) {
			if (!text.startsWith(keyword)) return false;
			if (text.length === keyword.length) return true;
			const next = text.charAt(keyword.length);
			// Next char must be a non-word character (space, punctuation, etc.)
			return /[^a-zA-Z0-9]/.test(next);
		}

		// Extract command text from the code block above a Run button
		function extractCommandText(btn: Element) {
			// Walk up to find the nearest code block
			let el: Element | null = btn;
			for (let i = 0; i < 10 && el; i++) {
				el = el.parentElement;
				if (!el) break;
				const code = el.querySelector('code, pre, [class*="terminal-command"], [class*="code-block"]');
				if (code) return (code.textContent || '').trim();
			}
			return '';
		}

		// Check command safety
		function isDangerous(cmd: string) {
			const lower = cmd.toLowerCase();
			return DANGEROUS.some(function (p) {
				// Word-boundary matching for dangerous commands
				const idx = lower.indexOf(p.toLowerCase());
				if (idx === -1) return false;
				// Check word boundary before
				if (idx > 0 && /[a-zA-Z0-9]/.test(lower.charAt(idx - 1))) return false;
				return true;
			});
		}

		// Robust click: full mouse event sequence for framework compatibility (React, Vue, Shadow DOM)
		function robustClick(el: Element) {
			const evtInit = { bubbles: true, cancelable: true, view: window, composed: true };
			el.dispatchEvent(new MouseEvent('mousedown', evtInit));
			el.dispatchEvent(new MouseEvent('mouseup', evtInit));
			el.dispatchEvent(new MouseEvent('click', evtInit));
		}

		function scanDOM() {
			if ((window as any).__AA_PAUSED) return;
			const results: any[] = [];
			const now = Date.now();

			// ── Unified scan: TreeWalker for all button types ──────────────────
			// Single O(D) pass over the DOM — handles run, accept, allow, retry, continue
			const walker = document.createTreeWalker(
				document.body,
				NodeFilter.SHOW_ELEMENT,
				{
					acceptNode: function (node: Element) {
						const tag = node.tagName;
						const role = node.getAttribute('role');
						const className = typeof node.className === 'string' ? node.className : (node.getAttribute('class') || '');

						if (tag === 'BUTTON' || tag.indexOf('-BUTTON') !== -1 || role === 'button' ||
							(tag === 'A' && (className.indexOf('monaco-button') !== -1 || className.indexOf('btn') !== -1 || className.indexOf('action') !== -1)) ||
							className.indexOf('monaco-button') !== -1 ||
							(tag === 'INPUT' && ((node as HTMLInputElement).type === 'button' || (node as HTMLInputElement).type === 'submit'))) {
							return NodeFilter.FILTER_ACCEPT;
						}
						return NodeFilter.FILTER_SKIP;
					}
				}
			);

			let node;
			while ((node = walker.nextNode())) {
				const el = node as Element;
				// Skip invisible elements
				const rect = el.getBoundingClientRect();
				if (rect.width === 0 || rect.height === 0) continue;

				// 🛡️ Skip VS Code native statusbar elements
				if (el.closest && el.closest('.part.statusbar, [id*="statusbar"]')) continue;
				const elClass = (el.getAttribute('class') || '').toLowerCase();
				if (elClass.indexOf('statusbar') !== -1) continue;

				// Cooldown check (use type-specific cooldown later for retry/continue)
				const lastDetect = parseInt(el.getAttribute('data-aa-t') || '0', 10);
				if (now - lastDetect < COOLDOWN_MS) continue;

				// Gather ALL text sources
				const rawText = (el.textContent || '').trim();
				const ariaLabel = (el.getAttribute('aria-label') || '').trim();
				const titleAttr = ((el as HTMLElement).title || '').trim();
				const text = (rawText || ariaLabel || titleAttr).toLowerCase();
				const allText = (rawText + ' ' + ariaLabel + ' ' + titleAttr).toLowerCase();

				// Priority-ordered matching (highest priority first)
				let detected: any = null;

				if (startsWithWord(text, 'run') && !text.startsWith('always run')) {
					// "Run Alt+d" button — NOT "Always run ^" dropdown
					const cmdText = extractCommandText(el);
					if (cmdText && isDangerous(cmdText)) {
						detected = { type: 'blocked', commandText: cmdText };
					} else {
						detected = { type: 'run-command', commandText: cmdText };
					}
				} else if (startsWithWord(text, 'accept') || text === '接受') {
					detected = { type: 'accept-edit' };
				} else if (text.startsWith('always allow')) {
					detected = { type: 'allow-permission' };
				} else if (text.startsWith('allow this conversation')) {
					detected = { type: 'allow-permission' };
				} else if (startsWithWord(text, 'allow') || text === '允许') {
					detected = { type: 'allow-permission' };
				} else if (allText.indexOf('retry') !== -1 || allText.indexOf('\u91cd\u8bd5') !== -1 ||
					allText.indexOf('try again') !== -1 || allText.indexOf('reconnect') !== -1 ||
					allText.indexOf('\u91cd\u65b0\u8fde\u63a5') !== -1) {
					detected = { type: 'retry-button' };
				} else if (startsWithWord(text, 'continue') || text === '继续') {
					detected = { type: 'continue-button' };
				}

				if (detected) {
					if (detected.type === 'blocked') {
						results.push({
							type: 'blocked-command',
							commandText: detected.commandText
						});
						continue;
					}

					if (detected.type === 'retry-button' || detected.type === 'continue-button') {
						// ── DETECT ONLY — do NOT click retry/continue buttons ──
						if (now - lastDetect < RETRY_COOLDOWN_MS) continue; // stricter cooldown for retry
						el.setAttribute('data-aa-t', String(now));
						results.push(detected);

						// Emergency stop: too many retry detections → auto-pause
						if (now - retryDetectWindowStart > EMERGENCY_WINDOW_MS) {
							retryDetectCount = 0;
							retryDetectWindowStart = now;
						}
						retryDetectCount++;
						if (retryDetectCount > EMERGENCY_THRESHOLD) {
							(window as any).__AA_PAUSED = true;
							results.push({ type: 'emergency-stop', reason: 'Too many retry detections (' + retryDetectCount + ' in ' + Math.round((now - retryDetectWindowStart) / 1000) + 's)' });
						}
					} else {
						// ── Other button types: click immediately as before ──
						robustClick(el);
						el.setAttribute('data-aa-t', String(now));
						results.push(detected);
					}
				}
			}

			// ── Iframe retry scan ─────────────────────────────────────────────
			// TreeWalker can't cross document boundaries, so scan iframes separately
			const iframes = document.querySelectorAll('iframe');
			for (let fi = 0; fi < iframes.length; fi++) {
				try {
					const iframeDoc = iframes[fi].contentDocument || iframes[fi].contentWindow?.document;
					if (!iframeDoc) continue;
					const iBtns = iframeDoc.querySelectorAll('button, [role="button"], a[class*="button"], [class*="retry"]');
					for (let bi = 0; bi < iBtns.length; bi++) {
						const ibtn = iBtns[bi];
						const iRect = ibtn.getBoundingClientRect();
						if (iRect.width === 0 || iRect.height === 0) continue;
						const iLast = parseInt(ibtn.getAttribute('data-aa-t') || '0', 10);
						if (now - iLast < RETRY_COOLDOWN_MS) continue;
						const iText = ((ibtn.textContent || '') + ' ' + (ibtn.getAttribute('aria-label') || '')).toLowerCase();
						if (iText.indexOf('retry') !== -1 || iText.indexOf('\u91cd\u8bd5') !== -1 ||
							iText.indexOf('try again') !== -1) {
							// Report only — no click
							ibtn.setAttribute('data-aa-t', String(now));
							results.push({ type: 'retry-button' });
						}
					}
				} catch (e) {
					// Cross-origin iframe, ignore
				}
			}

			// ── Error classification ──────────────────────────────────────────
			const errorClassification = [
				{ patterns: ['quota exceeded', '额度已用完', '配额', 'resource exhausted'], category: 'quota-exhausted' },
				{ patterns: ['rate limit', 'too many requests', '429'], category: 'rate-limited' },
				{ patterns: ['capacity', 'overloaded', 'high traffic'], category: 'capacity-exhausted' },
				{ patterns: ['agent terminated', 'connection error', 'connection lost', 'session expired', 'timed out'], category: 'agent-terminated' },
				{ patterns: ['server error', 'internal error', 'failed to', '503', '500', 'experiencing'], category: 'server-error' }
			];
			const notifications = document.querySelectorAll(
				'.notifications-toasts .notification-toast, ' +
				'[class*="error-message"], [class*="notification"], ' +
				'.monaco-dialog-box'
			);
			for (let ni = 0; ni < notifications.length; ni++) {
				const ntext = (notifications[ni].textContent || '').toLowerCase();
				let classified = false;
				for (let ci = 0; ci < errorClassification.length && !classified; ci++) {
					const group = errorClassification[ci];
					for (let pi = 0; pi < group.patterns.length; pi++) {
						if (ntext.indexOf(group.patterns[pi]) !== -1) {
							results.push({
								type: 'error-classified',
								errorCategory: group.category,
								text: (notifications[ni].textContent || '').trim().substring(0, 200)
							});
							classified = true;
							break;
						}
					}
				}
			}

			// ── Report all results in a single binding call ───────────────────
			if (results.length > 0) {
				try {
					(window as any)[bindingName](JSON.stringify(results));
				} catch { /* ignore */ }
			}
		}

		// MutationObserver: react instantly to DOM changes
		const observer = new MutationObserver(function () {
			if (throttleTimer) return; // Leading-edge throttle
			throttleTimer = setTimeout(function () {
				throttleTimer = null;
				scanDOM();
			}, THROTTLE_MS);
		});

		observer.observe(document.body, {
			childList: true,
			subtree: true,
			attributes: true,
			attributeFilter: ['style', 'class', 'hidden', 'aria-hidden'],
		});

		// Polling fallback
		setInterval(scanDOM, 2000);

		(window as any).__AA_OBSERVER_ACTIVE = true;

		// Initial scan
		setTimeout(scanDOM, 300);

		return 'injected';
	}

	return `(${injectedObserver.toString()})("${BINDING_NAME}", ${JSON.stringify(dangerousCommands)})`;
}

/**
 * Lightweight dialog-only observer script for the MAIN workbench window.
 *
 * The "Agent terminated due to error" dialog renders in the main Electron
 * workbench window, NOT inside the `vscode-webview://` iframe. This script
 * is injected into the main window session to detect and click retry/dismiss
 * buttons in Monaco dialog boxes.
 *
 * Design:
 * - Watches only for `.monaco-dialog-box` containers
 * - 3s cooldown per button to prevent double-clicks
 * - Uses MutationObserver (event-driven) + 2s polling fallback
 * - Reports back via binding IPC
 */
export function buildDialogObserverScript(bindingName: string): string {
	function injectedDialogObserver(bindingName: string) {
		if ((window as any).__AA_DIALOG_OBSERVER_ACTIVE) return 'already_injected';

		const COOLDOWN_MS = 3000;
		const RETRY_COOLDOWN_MS = 15000;
		const POLL_MS = 2000;
		let throttleTimer: any = null;

		let retryDetectCount = 0;
		let retryDetectWindowStart = 0;
		const EMERGENCY_WINDOW_MS = 60000;
		const EMERGENCY_THRESHOLD = 5;

		function startsWithWord(text: string, keyword: string) {
			if (!text.startsWith(keyword)) return false;
			if (text.length === keyword.length) return true;
			const next = text.charAt(keyword.length);
			return /[^a-zA-Z0-9]/.test(next);
		}

		function scanDialogs() {
			if ((window as any).__AA_PAUSED) return;
			const now = Date.now();
			const results: any[] = [];

			// ── Stage 1: Targeted dialog container scan ──────────────────────
			const dialogBtns = document.querySelectorAll(
				// Monaco dialog boxes
				'.monaco-dialog-box button, .monaco-dialog-box [role="button"], ' +
				'.monaco-dialog-box a.monaco-button, .monaco-dialog-box .monaco-button, ' +
				// Any element with "dialog" in class
				'[class*="dialog"] button, [class*="dialog"] [role="button"], [class*="dialog"] .monaco-button, ' +
				// Notification toasts
				'.notifications-toasts button, .notifications-toasts [role="button"], .notifications-toasts a.monaco-button, ' +
				// Additional containers: modals, overlays, popups, alerts, banners
				'[class*="modal"] button, [class*="modal"] [role="button"], ' +
				'[class*="overlay"] button, [class*="overlay"] [role="button"], ' +
				'[class*="popup"] button, [class*="popup"] [role="button"], ' +
				'[class*="alert"] button, [class*="alert"] [role="button"], ' +
				'[class*="error"] button, [class*="error"] [role="button"], ' +
				'[class*="banner"] button, [class*="banner"] [role="button"], ' +
				'[class*="toast"] button, [class*="toast"] [role="button"]'
			);

			for (let i = 0; i < dialogBtns.length; i++) {
				const btn = dialogBtns[i];
				const rect = btn.getBoundingClientRect();
				if (rect.width === 0 || rect.height === 0) continue;

				const lastDetect = parseInt(btn.getAttribute('data-aa-t') || '0', 10);
				if (now - lastDetect < RETRY_COOLDOWN_MS) continue;

				// Check ALL text sources simultaneously
				const rawText = (btn.textContent || '').trim();
				const btnAria = (btn.getAttribute('aria-label') || '').trim();
				const btnTitle = ((btn as HTMLElement).title || '').trim();
				const btnAllText = (rawText + ' ' + btnAria + ' ' + btnTitle).toLowerCase();

				if (btnAllText.indexOf('retry') !== -1 || btnAllText.indexOf('\u91cd\u8bd5') !== -1 ||
					btnAllText.indexOf('try again') !== -1 || btnAllText.indexOf('reconnect') !== -1 ||
					btnAllText.indexOf('\u91cd\u65b0\u8fde\u63a5') !== -1) {
					// Detect only - no click
					btn.setAttribute('data-aa-t', String(now));
					results.push({ type: 'retry-button' });

					// Emergency stop: too many retry detections → auto-pause
					if (now - retryDetectWindowStart > EMERGENCY_WINDOW_MS) {
						retryDetectCount = 0;
						retryDetectWindowStart = now;
					}
					retryDetectCount++;
					if (retryDetectCount > EMERGENCY_THRESHOLD) {
						(window as any).__AA_PAUSED = true;
						results.push({ type: 'emergency-stop', reason: 'Too many retry detections (' + retryDetectCount + ' in ' + Math.round((now - retryDetectWindowStart) / 1000) + 's)' });
					}
				}
			}

			// ── Stage 2: Error classification ────────────────────────────────
			const errorClassification = [
				{ patterns: ['quota exceeded', 'resource exhausted'], category: 'quota-exhausted' },
				{ patterns: ['rate limit', 'too many requests', '429'], category: 'rate-limited' },
				{ patterns: ['capacity', 'overloaded', 'high traffic'], category: 'capacity-exhausted' },
				{ patterns: ['agent terminated', 'connection error', 'connection lost', 'session expired', 'timed out'], category: 'agent-terminated' },
				{ patterns: ['server error', 'internal error', 'failed to', '503', '500', 'experiencing'], category: 'server-error' }
			];
			const dialogs = document.querySelectorAll(
				'.monaco-dialog-box, .notifications-toasts .notification-toast, ' +
				'.notification-list-item, .notifications-center .notification-list-item, ' +
				'[class*="error-message"], [class*="notification"], ' +
				'[class*="alert"], [class*="banner"], [class*="toast"], ' +
				'[class*="dialog"], [class*="modal"], ' +
				'[class*="message-container"], [class*="error-container"]'
			);
			for (let d = 0; d < dialogs.length; d++) {
				const dText = (dialogs[d].textContent || '').toLowerCase();
				let dClassified = false;
				for (let ci = 0; ci < errorClassification.length && !dClassified; ci++) {
					const dGroup = errorClassification[ci];
					for (let pi = 0; pi < dGroup.patterns.length; pi++) {
						if (dText.indexOf(dGroup.patterns[pi]) !== -1) {
							results.push({
								type: 'error-classified',
								errorCategory: dGroup.category,
								text: (dialogs[d].textContent || '').trim().substring(0, 200)
							});
							dClassified = true;
							break;
						}
					}
				}
			}

			if (results.length > 0) {
				try {
					(window as any)[bindingName](JSON.stringify(results));
				} catch { /* ignore */ }
			}
		}

		// MutationObserver for instant detection
		const observer = new MutationObserver(function () {
			if (throttleTimer) return;
			throttleTimer = setTimeout(function () {
				throttleTimer = null;
				scanDialogs();
			}, 100);
		});

		observer.observe(document.body, {
			childList: true,
			subtree: true,
			attributes: true,
			attributeFilter: ['style', 'class', 'hidden', 'aria-hidden']
		});

		// Polling fallback
		setInterval(scanDialogs, POLL_MS);

		(window as any).__AA_DIALOG_OBSERVER_ACTIVE = true;

		// Initial scan
		setTimeout(scanDialogs, 300);

		return 'injected';
	}

	return `(${injectedDialogObserver.toString()})("${bindingName}")`;
}

/**
 * Builds the script to inject a mock error dialog.
 */
export function buildMockDialogScript(titleText: string, bodyText: string): string {
	function injectedMockDialog(titleText: string, bodyText: string) {
		// Remove any existing mock dialog
		const existing = document.getElementById('aa-mock-error-dialog');
		if (existing) existing.remove();

		const overlay = document.createElement('div');
		overlay.id = 'aa-mock-error-dialog';
		overlay.style.cssText =
			'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.4);z-index:99999;display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,sans-serif;';

		const dialog = document.createElement('div');
		dialog.className = 'monaco-dialog-box';
		dialog.style.cssText =
			'background:#1e1e1e;border:1px solid #454545;border-radius:8px;padding:20px 24px;max-width:480px;width:90%;color:#ccc;box-shadow:0 8px 32px rgba(0,0,0,0.5);';

		const titleEl = document.createElement('div');
		titleEl.style.cssText = 'font-size:14px;font-weight:600;color:#e0e0e0;margin-bottom:12px;';
		titleEl.textContent = titleText;

		const bodyEl = document.createElement('div');
		bodyEl.style.cssText = 'font-size:13px;color:#aaa;margin-bottom:20px;line-height:1.5;';
		bodyEl.textContent = bodyText;

		const btnRow = document.createElement('div');
		btnRow.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;';

		const dismissBtn = document.createElement('button');
		dismissBtn.textContent = 'Dismiss';
		dismissBtn.style.cssText =
			'padding:6px 14px;border:1px solid #555;background:#2d2d2d;color:#ccc;border-radius:4px;cursor:pointer;font-size:13px;';
		dismissBtn.onclick = function () {
			overlay.remove();
		};

		const copyBtn = document.createElement('button');
		copyBtn.textContent = 'Copy debug info';
		copyBtn.style.cssText =
			'padding:6px 14px;border:1px solid #555;background:#2d2d2d;color:#ccc;border-radius:4px;cursor:pointer;font-size:13px;';

		const retryBtn = document.createElement('button');
		retryBtn.textContent = 'Retry';
		retryBtn.setAttribute('role', 'button');
		retryBtn.style.cssText =
			'padding:6px 18px;border:none;background:#0e7c6b;color:#fff;border-radius:4px;cursor:pointer;font-size:13px;font-weight:600;';
		retryBtn.onclick = function () {
			overlay.remove();
		};

		btnRow.appendChild(dismissBtn);
		btnRow.appendChild(copyBtn);
		btnRow.appendChild(retryBtn);
		dialog.appendChild(titleEl);
		dialog.appendChild(bodyEl);
		dialog.appendChild(btnRow);
		overlay.appendChild(dialog);
		document.body.appendChild(overlay);

		return 'mock-dialog-injected';
	}

	return `(${injectedMockDialog.toString()})(${JSON.stringify(titleText)}, ${JSON.stringify(bodyText)})`;
}

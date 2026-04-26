/// <reference lib="dom" />
import { CDPClient, CDPSession } from './cdpClient';

/**
 * Error categories for differentiated retry/rotation strategies.
 *
 * - quota-exhausted: Daily/weekly quota depleted → switch model
 * - rate-limited: Too many requests in short window → wait 30s, DON'T switch model
 * - capacity-exhausted: Model overloaded → wait 15s, retry
 * - server-error: Backend failure → wait 20s, retry
 * - agent-terminated: Agent process crashed → immediate retry
 */
export type ErrorCategory =
	| 'quota-exhausted'
	| 'rate-limited'
	| 'capacity-exhausted'
	| 'server-error'
	| 'agent-terminated';

/**
 * Detected UI element types that may appear in the IDE agent panel.
 */
export type DetectedElement =
	| { type: 'run-command'; commandText: string; sessionTargetId: string }
	| { type: 'accept-edit'; sessionTargetId: string }
	| { type: 'accept-command'; commandText: string; sessionTargetId: string }
	| { type: 'allow-permission'; sessionTargetId: string }
	| { type: 'retry-button'; sessionTargetId: string }
	| { type: 'continue-button'; sessionTargetId: string }
	| { type: 'error-message'; text: string; sessionTargetId: string }
	| {
			type: 'error-classified';
			errorCategory: ErrorCategory;
			text: string;
			sessionTargetId: string;
	  }
	| { type: 'model-selector'; currentModel: string; sessionTargetId: string }
	| { type: 'emergency-stop'; reason: string; sessionTargetId: string };

export type ElementCallback = (element: DetectedElement) => void;

import {
	BINDING_NAME,
	buildObserverScript,
	buildDialogObserverScript,
	buildMockDialogScript,
} from './injectedScripts';

/**
 * DOMMonitor — Injects MutationObserver into webview sessions for event-driven
 * button detection and auto-clicking.
 *
 * Architecture:
 * - Registers a Runtime.addBinding callback on CDPClient
 * - When CDPClient discovers a new webview session, DOMMonitor injects the observer
 * - The observer uses MutationObserver (event-driven, not polling) to detect buttons
 * - Detected elements are clicked in-page, then reported back via binding IPC
 * - Heartbeat re-injection: if observer dies (context cleared), auto re-injects
 * - Main window dialog watcher: separate lightweight observer for Monaco dialogs
 *
 * Button priority: run > accept > always allow > allow > retry > continue
 */
export class DOMMonitor {
	private cdp: CDPClient;
	private log: (msg: string) => void;
	private callbacks: ElementCallback[] = [];
	private dangerousCommands: string[] = [];
	/** Sessions that have been successfully injected. */
	private injectedSessions = new Set<string>();
	/** Timer for checking new/dead sessions. */
	private checkTimer: NodeJS.Timeout | undefined;
	private started = false;

	/** Injection check interval. */
	private static readonly CHECK_INTERVAL_MS = 5_000;

	constructor(cdp: CDPClient, log: (msg: string) => void) {
		this.cdp = cdp;
		this.log = log;

		// Register the IPC binding on CDPClient
		this.cdp.addBinding(BINDING_NAME, (payload, session) => {
			this.handleBindingPayload(payload, session);
		});
	}

	/**
	 * Register a callback for detected UI elements.
	 */
	onDetect(callback: ElementCallback): void {
		this.callbacks.push(callback);
	}

	/**
	 * Update the dangerous commands list (for in-page filtering).
	 */
	updateDangerousCommands(commands: string[]): void {
		this.dangerousCommands = commands;
		// Re-inject all sessions with new dangerous commands list
		if (this.started) {
			this.reinjectAll();
		}
	}

	/**
	 * Start monitoring — inject observers into all current and future sessions.
	 */
	start(): void {
		this.stop();
		this.started = true;
		this.log('DOMMonitor: Started (MutationObserver mode)');

		// Unpause any previously paused observers
		this.setPaused(false);

		// Inject into existing sessions (including main window)
		this.injectAllSessions();

		// Periodically check for new sessions that need injection
		this.checkTimer = setInterval(() => {
			this.injectAllSessions();
			this.healthCheck();
		}, DOMMonitor.CHECK_INTERVAL_MS);
	}

	/**
	 * Stop monitoring.
	 */
	stop(): void {
		this.started = false;
		if (this.checkTimer) {
			clearInterval(this.checkTimer);
			this.checkTimer = undefined;
		}
		// Pause all injected observers so they stop scanning/clicking
		this.setPaused(true);
		this.injectedSessions.clear();
	}

	/**
	 * Inject the MutationObserver into all sessions that haven't been injected yet.
	 */
	private async injectAllSessions(): Promise<void> {
		for (const [targetId, session] of this.cdp.sessions) {
			if (!this.injectedSessions.has(targetId)) {
				await this.injectSession(session);
			}
		}

		// Prune injected set for sessions that no longer exist
		for (const targetId of this.injectedSessions) {
			if (!this.cdp.sessions.has(targetId)) {
				this.injectedSessions.delete(targetId);
			}
		}
	}

	/**
	 * Inject the appropriate MutationObserver script into a session.
	 * - Main window sessions get the lightweight dialog-only observer
	 * - Webview sessions get the full agent panel observer
	 */
	private async injectSession(session: CDPSession): Promise<void> {
		try {
			// Choose the right script based on session type
			const script = session.isMainWindow
				? buildDialogObserverScript(BINDING_NAME)
				: buildObserverScript(this.dangerousCommands);

			const result = await this.cdp.evalInSession(session, script);

			if (result === 'injected') {
				this.injectedSessions.add(session.targetId);
				session.observerAlive = true;
				this.log(
					`DOMMonitor: ✓ ${session.isMainWindow ? 'Dialog observer' : 'Observer'} injected into ${session.targetId.substring(0, 8)}`
				);
			} else if (result === 'already_injected') {
				this.injectedSessions.add(session.targetId);
				session.observerAlive = true;
			} else if (!session.isMainWindow) {
				// Not an agent panel target — ignore it (only for webview sessions)
				this.log(
					`DOMMonitor: Target ${session.targetId.substring(0, 8)} is not an agent panel — ignoring`
				);
				this.cdp.ignoreTarget(session.targetId);
			}
		} catch (err) {
			// Execution context may have been cleared — will retry next cycle
			this.log(
				`DOMMonitor: Injection failed for ${session.targetId.substring(0, 8)}: ${err}`
			);
		}
	}

	/**
	 * Re-inject all sessions (e.g., when dangerous commands list changes).
	 */
	reinjectAll(): void {
		this.injectedSessions.clear();
		for (const session of this.cdp.sessions.values()) {
			session.observerAlive = false;
		}
		this.injectAllSessions();
	}

	/**
	 * Health check — verify observers are still alive in each session.
	 * Re-injects if the execution context was cleared (webview navigation, React hot-reload).
	 */
	private async healthCheck(): Promise<void> {
		for (const [targetId, session] of this.cdp.sessions) {
			if (!this.injectedSessions.has(targetId)) continue;

			try {
				// Check the right flag depending on session type
				const checkExpr = session.isMainWindow
					? 'window.__AA_DIALOG_OBSERVER_ACTIVE === true'
					: 'window.__AA_OBSERVER_ACTIVE === true';
				const alive = await this.cdp.evalInSession(session, checkExpr);
				if (alive !== true) {
					this.log(
						`DOMMonitor: Observer dead in ${targetId.substring(0, 8)} — re-injecting`
					);
					this.injectedSessions.delete(targetId);
					session.observerAlive = false;
					await this.injectSession(session);
				}
			} catch {
				// Context cleared — re-inject
				this.injectedSessions.delete(targetId);
				session.observerAlive = false;
			}
		}
	}

	/**
	 * Handle the IPC payload from an injected observer script.
	 */
	private handleBindingPayload(payload: string, session: CDPSession): void {
		let elements: Array<{
			type: string;
			commandText?: string;
			text?: string;
			errorCategory?: string;
			buttonType?: string;
			btnText?: string;
			reason?: string;
		}>;
		try {
			elements = JSON.parse(payload);
		} catch {
			return;
		}

		for (const raw of elements) {
			let el: DetectedElement | null = null;

			switch (raw.type) {
				case 'run-command':
					el = {
						type: 'run-command',
						commandText: raw.commandText || '',
						sessionTargetId: session.targetId,
					};
					break;
				case 'accept-edit':
					el = { type: 'accept-edit', sessionTargetId: session.targetId };
					break;
				case 'accept-command':
					el = {
						type: 'accept-command',
						commandText: raw.commandText || '',
						sessionTargetId: session.targetId,
					};
					break;
				case 'allow-permission':
					el = { type: 'allow-permission', sessionTargetId: session.targetId };
					break;
				case 'retry-button':
					el = { type: 'retry-button', sessionTargetId: session.targetId };
					break;
				case 'continue-button':
					el = { type: 'continue-button', sessionTargetId: session.targetId };
					break;
				case 'error-message':
					el = {
						type: 'error-message',
						text: raw.text || '',
						sessionTargetId: session.targetId,
					};
					break;
				case 'error-classified':
					el = {
						type: 'error-classified',
						errorCategory: (raw.errorCategory || 'agent-terminated') as ErrorCategory,
						text: raw.text || '',
						sessionTargetId: session.targetId,
					};
					this.log(
						`DOMMonitor: Error classified as [${raw.errorCategory}]: "${(raw.text || '').substring(0, 80)}"`
					);
					break;
				case 'blocked-command':
					// Handled separately — emit as error
					this.log(`DOMMonitor: ⛔ Blocked dangerous command: ${raw.commandText}`);
					continue;
				case 'click-verified':
					this.log(`DOMMonitor: ✓ Click verified — ${raw.buttonType} button dismissed`);
					continue;
				case 'click-unverified':
					this.log(
						`DOMMonitor: ⚠ Click unverified — ${raw.buttonType} button still visible: "${raw.btnText}". Cooldown cleared for re-scan.`
					);
					continue;
				case 'emergency-stop':
					this.log(`DOMMonitor: ⛔ EMERGENCY STOP — ${raw.reason}`);
					this.setPaused(true);
					el = {
						type: 'emergency-stop',
						reason: raw.reason || 'Unknown',
						sessionTargetId: session.targetId,
					};
					break;
			}

			if (el) {
				for (const cb of this.callbacks) {
					cb(el);
				}
			}
		}
	}

	/**
	 * On-demand retry scan — actively search for and click retry buttons
	 * across ALL CDP sessions. Used by the "Retry Now" command and
	 * AutoRetry's triggerRetry() for proactive retry attempts.
	 *
	 * Returns true if a retry button was found and clicked in any session.
	 */
	async findAndClickRetry(): Promise<boolean> {
		function injectedFindAndClick() {
			const selectors =
				'button, [role="button"], a.monaco-button, [class*="monaco-button"], ' +
				'[class*="retry"], [data-testid*="retry"], [data-action*="retry"], ' +
				'.monaco-dialog-box button, .monaco-dialog-box [role="button"], ' +
				'[class*="dialog"] button, [class*="dialog"] [role="button"], ' +
				'.notifications-toasts button, .notifications-toasts [role="button"]';
			const btns = document.querySelectorAll(selectors);
			for (let i = 0; i < btns.length; i++) {
				const btn = btns[i];
				// Skip statusbar elements
				if (btn.closest && btn.closest('.part.statusbar, [id*="statusbar"]')) continue;
				const rect = btn.getBoundingClientRect();
				if (rect.width === 0 || rect.height === 0) continue;
				const rawText = (btn.textContent || '').trim();
				const aria = (btn.getAttribute('aria-label') || '').trim();
				const title = ((btn as HTMLElement).title || '').trim();
				const allText = (rawText + ' ' + aria + ' ' + title).toLowerCase();
				if (
					allText.indexOf('retry') !== -1 ||
					allText.indexOf('\u91cd\u8bd5') !== -1 ||
					allText.indexOf('try again') !== -1 ||
					allText.indexOf('reconnect') !== -1 ||
					allText.indexOf('\u91cd\u65b0\u8fde\u63a5') !== -1
				) {
					// Robust click: full mouse event sequence
					const evtInit = {
						bubbles: true,
						cancelable: true,
						view: window,
						composed: true,
					};
					btn.dispatchEvent(new MouseEvent('mousedown', evtInit));
					btn.dispatchEvent(new MouseEvent('mouseup', evtInit));
					btn.dispatchEvent(new MouseEvent('click', evtInit));
					btn.setAttribute('data-aa-t', String(Date.now()));
					return rawText.substring(0, 50);
				}
			}
			// Also scan iframes
			const iframes = document.querySelectorAll('iframe');
			for (let fi = 0; fi < iframes.length; fi++) {
				try {
					const iframeDoc =
						iframes[fi].contentDocument || iframes[fi].contentWindow?.document;
					if (!iframeDoc) continue;
					const iBtns = iframeDoc.querySelectorAll(selectors);
					for (let j = 0; j < iBtns.length; j++) {
						const ibtn = iBtns[j];
						const iRect = ibtn.getBoundingClientRect();
						if (iRect.width === 0 || iRect.height === 0) continue;
						const iText = (
							(ibtn.textContent || '') +
							' ' +
							(ibtn.getAttribute('aria-label') || '')
						).toLowerCase();
						if (iText.indexOf('retry') !== -1 || iText.indexOf('try again') !== -1) {
							const iEvt = {
								bubbles: true,
								cancelable: true,
								view: iframes[fi].contentWindow,
								composed: true,
							};
							ibtn.dispatchEvent(new MouseEvent('mousedown', iEvt as EventInit));
							ibtn.dispatchEvent(new MouseEvent('mouseup', iEvt as EventInit));
							ibtn.dispatchEvent(new MouseEvent('click', iEvt as EventInit));
							return (ibtn.textContent || '').trim().substring(0, 50);
						}
					}
				} catch {
					/* ignore */
				}
			}
			return false;
		}

		const script = `(${injectedFindAndClick.toString()})()`;

		this.log('DOMMonitor: On-demand retry scan triggered');

		const results = await this.cdp.evaluateAll(script);
		for (const [targetId, val] of results) {
			if (val && val !== false) {
				this.log(
					`DOMMonitor: ✓ Retry button clicked via on-demand scan in ${targetId.substring(0, 8)}: "${val}"`
				);
				return true;
			}
		}

		this.log('DOMMonitor: No retry button found in any session');
		return false;
	}

	/**
	 * Click a button by evaluating a click script in a specific session.
	 * Note: In the new architecture, buttons are clicked IN-PAGE by the observer.
	 * This method is kept as a fallback for manual clicks.
	 */
	async clickInSession(session: CDPSession, clickScript: string): Promise<boolean> {
		try {
			const result = await this.cdp.evalInSession(session, clickScript);
			return result === true;
		} catch {
			return false;
		}
	}

	/**
	 * Inject a mock error dialog into all sessions for testing.
	 * Simulates the real Antigravity "Agent terminated due to error" dialog
	 * with Retry / Copy debug info / Dismiss buttons.
	 *
	 * @param errorType - Type of error to simulate (controls text and classification)
	 */
	async injectMockErrorDialog(
		errorType:
			| 'agent-terminated'
			| 'rate-limited'
			| 'quota-exhausted'
			| 'server-error' = 'agent-terminated'
	): Promise<boolean> {
		const errorMessages: Record<string, { title: string; body: string }> = {
			'agent-terminated': {
				title: '⊘ Agent terminated due to error',
				body: 'You can prompt the model to try again or start a new conversation if the error persists.\nSee our troubleshooting guide for more help.',
			},
			'rate-limited': {
				title: '⊘ Rate limit exceeded (429)',
				body: 'Too many requests. Please wait a moment before trying again.\nRate limit will reset shortly.',
			},
			'quota-exhausted': {
				title: '⊘ Quota exceeded',
				body: 'Your resource exhausted for this model. Please try a different model or wait for quota to reset.',
			},
			'server-error': {
				title: '⊘ Internal server error (503)',
				body: 'The server is temporarily overloaded. Please try again later.',
			},
		};

		const msg = errorMessages[errorType] || errorMessages['agent-terminated'];

		const script = buildMockDialogScript(msg.title, msg.body);

		this.log(`DOMMonitor: 🧪 Injecting mock error dialog [${errorType}] into all sessions...`);

		const results = await this.cdp.evaluateAll(script);
		let injected = false;
		for (const [targetId, val] of results) {
			if (val === 'mock-dialog-injected') {
				this.log(`DOMMonitor: 🧪 Mock dialog injected into ${targetId.substring(0, 8)}`);
				injected = true;
			}
		}

		if (!injected) {
			this.log('DOMMonitor: 🧪 Failed to inject mock dialog into any session');
		}

		return injected;
	}

	/**
	 * Pause or unpause all injected observer scripts.
	 * When paused, the in-page scanAndClick/scanDialogs functions return immediately
	 * without scanning or clicking any buttons.
	 */
	setPaused(paused: boolean): void {
		const script = `window.__AA_PAUSED = ${paused ? 'true' : 'false'}`;
		for (const session of this.cdp.sessions.values()) {
			this.cdp.evalInSession(session, script).catch(() => {
				// Session may be dead, ignore
			});
		}
		this.log(`DOMMonitor: ${paused ? '⏸ Paused' : '▶ Unpaused'} all injected observers`);
	}

	dispose(): void {
		this.stop();
		this.callbacks = [];
	}
}

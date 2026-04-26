import * as vscode from 'vscode';
import { DOMMonitor, DetectedElement, ErrorCategory } from '../cdp/domMonitor';

/**
 * AutoRetry — Tracks and orchestrates automatic retries of AI agent requests.
 *
 * Error-aware retry strategies:
 * - agent-terminated: Immediate retry (standard behavior)
 * - server-error: Wait 20s before allowing next retry
 * - capacity-exhausted: Wait 15s before allowing next retry
 * - rate-limited: Wait 30s, DON'T count as retry attempt (to avoid triggering model rotation)
 * - quota-exhausted: Skip — deferred to ModelRotation handler
 *
 * Anti-infinite-loop mechanisms:
 * - Global retry cap: max `maxAttempts * 3` retries within a 30-minute sliding window
 * - Escalating cooldown: each resetCount() increases the backoff multiplier via `resetGeneration`
 * - fullReset(): only called on explicit user action (manual retry), resets everything
 *
 * Also supports:
 * - Active triggerRetry() for on-demand scans
 * - Max retry limits to prevent infinite loops
 * - delayMs as configurable debounce interval
 */
export class AutoRetry implements vscode.Disposable {
	private monitor: DOMMonitor;
	private log: (msg: string) => void;
	private enabled = true;
	private maxAttempts: number;
	private delayMs: number;

	/** Number of consecutive retries in the current session. */
	private retryCount = 0;
	/** Timestamp of the last retry to avoid double-triggering. */
	private lastRetryTime = 0;
	/** Wait period imposed by rate-limit/server-error detection. Retries are paused until this time. */
	private waitUntil = 0;

	/**
	 * Global retry counter within a sliding time window.
	 * Prevents infinite retry loops even when retryCount is reset by model rotation or timers.
	 */
	private globalRetryCount = 0;
	/** Start of the global retry window. */
	private globalWindowStart = 0;
	/** Duration of the global retry window (30 minutes). */
	private static readonly GLOBAL_WINDOW_MS = 30 * 60 * 1000;

	/**
	 * Number of times resetCount() has been called in this session.
	 * Used for escalating cooldown — even after resetting the consecutive counter,
	 * the backoff doesn't drop back to zero.
	 */
	private resetGeneration = 0;

	/** Whether the global cap has been hit and we are in suppressed state. */
	private globalCapReached = false;

	/** Total retries since extension activation (for stats). */
	totalRetries = 0;

	/** Lock to prevent concurrent click attempts from rapid detection events. */
	private clickInProgress = false;

	/** Event fired when a retry is triggered. */
	private _onRetry = new vscode.EventEmitter<{ attempt: number; maxAttempts: number }>();
	readonly onRetry = this._onRetry.event;

	/** Event fired when max retries exceeded. */
	private _onMaxRetriesExceeded = new vscode.EventEmitter<void>();
	readonly onMaxRetriesExceeded = this._onMaxRetriesExceeded.event;

	/** Wait durations per error category (ms). */
	private static readonly ERROR_WAIT_MS: Record<ErrorCategory, number> = {
		'agent-terminated': 0,
		'server-error': 20_000,
		'capacity-exhausted': 15_000,
		'rate-limited': 30_000,
		'quota-exhausted': 0, // Handled by ModelRotation, not AutoRetry
	};

	/** Maximum backoff interval (cap for exponential growth). */
	private static readonly MAX_BACKOFF_MS = 60_000;

	/**
	 * Post-click cooldown: after a successful retry click, suppress ALL retry
	 * events for this duration. This prevents the MutationObserver → click →
	 * DOM mutation → detect → click infinite cycle by giving the agent
	 * enough time to recover or produce a new error.
	 */
	private static readonly POST_CLICK_COOLDOWN_MS = 30_000;

	/** Timestamp until which all retry events are suppressed after a successful click. */
	private postClickCooldownUntil = 0;

	constructor(
		monitor: DOMMonitor,
		log: (msg: string) => void,
		maxAttempts: number,
		delayMs: number
	) {
		this.monitor = monitor;
		this.log = log;
		this.maxAttempts = maxAttempts;
		this.delayMs = delayMs;

		this.monitor.onDetect((el) => {
			this.handleElement(el).catch((err) => {
				this.log(`AutoRetry: Error handling element: ${err}`);
			});
		});
	}

	setEnabled(enabled: boolean): void {
		this.enabled = enabled;
		if (!enabled) {
			this.resetCount();
			this.waitUntil = 0;
		}
	}

	updateConfig(maxAttempts: number, delayMs: number): void {
		this.maxAttempts = maxAttempts;
		this.delayMs = delayMs;
	}

	/**
	 * Reset the consecutive retry counter (e.g., after model rotation).
	 * Does NOT reset the global retry cap or escalating cooldown —
	 * this prevents infinite loops through repeated resets.
	 */
	resetCount(): void {
		this.retryCount = 0;
		this.waitUntil = 0;
		this.resetGeneration++;
		this.log(`AutoRetry: resetCount() — generation=${this.resetGeneration}, globalRetries=${this.globalRetryCount}`);
	}

	/**
	 * Full reset — clears ALL counters including global cap and escalation.
	 * Only call this on explicit user action (e.g., manual "Retry Now" command).
	 */
	fullReset(): void {
		this.retryCount = 0;
		this.waitUntil = 0;
		this.resetGeneration = 0;
		this.globalRetryCount = 0;
		this.globalWindowStart = 0;
		this.globalCapReached = false;
		this.postClickCooldownUntil = 0;
		this.log('AutoRetry: fullReset() — all counters cleared');
	}

	/**
	 * Check if the global retry cap has been reached.
	 */
	isGlobalCapReached(): boolean {
		return this.globalCapReached;
	}

	/**
	 * Check and update the global retry window.
	 * Returns true if the global cap has been exceeded.
	 */
	private checkGlobalCap(): boolean {
		const now = Date.now();
		const globalMax = this.maxAttempts * 3;

		// Reset the window if it has expired
		if (now - this.globalWindowStart > AutoRetry.GLOBAL_WINDOW_MS) {
			this.globalRetryCount = 0;
			this.globalWindowStart = now;
			this.globalCapReached = false;
		}

		if (this.globalRetryCount >= globalMax) {
			if (!this.globalCapReached) {
				this.globalCapReached = true;
				this.log(
					`AutoRetry: ⛔ Global retry cap reached (${this.globalRetryCount}/${globalMax} in ${Math.round(
						(now - this.globalWindowStart) / 1000
					)}s window). Suppressing ALL retries.`
				);
			}
			return true;
		}

		return false;
	}

	/**
	 * Compute exponential backoff with jitter and escalating cooldown.
	 * Formula: min(delayMs * 2^(retryCount-1) * (1 + resetGeneration * 0.5) + random_jitter, MAX_BACKOFF_MS)
	 *
	 * The resetGeneration factor ensures that even after resetCount(),
	 * the backoff doesn't drop back to zero — it escalates across resets.
	 *
	 * Example with delayMs=3000, resetGeneration=0:
	 *   attempt 1: 3000ms + jitter
	 *   attempt 2: 6000ms + jitter
	 *   attempt 3: 12000ms + jitter
	 *
	 * Example with delayMs=3000, resetGeneration=2 (after 2 resets):
	 *   attempt 1: 3000 * 2.0 = 6000ms + jitter
	 *   attempt 2: 6000 * 2.0 = 12000ms + jitter
	 */
	private computeBackoff(): number {
		const exponential = this.delayMs * Math.pow(2, Math.max(0, this.retryCount - 1));
		const generationMultiplier = 1 + this.resetGeneration * 0.5;
		const jitter = Math.random() * Math.min(this.delayMs, 2000); // jitter up to delayMs or 2s
		return Math.min(exponential * generationMultiplier + jitter, AutoRetry.MAX_BACKOFF_MS);
	}

	/**
	 * Actively trigger a retry — scan all CDP sessions for retry buttons and click.
	 * Unlike passive detection, this does NOT wait for MutationObserver events.
	 *
	 * Returns true if a retry button was found and clicked.
	 */
	async triggerRetry(): Promise<boolean> {
		if (!this.enabled) {
			this.log('AutoRetry: triggerRetry() called but disabled');
			return false;
		}

		// Check global cap
		if (this.checkGlobalCap()) {
			this.log('AutoRetry: triggerRetry() blocked — global cap reached');
			this._onMaxRetriesExceeded.fire();
			return false;
		}

		// Check max retries
		if (this.retryCount >= this.maxAttempts) {
			this.log(`AutoRetry: triggerRetry() blocked — max attempts (${this.maxAttempts}) reached`);
			this._onMaxRetriesExceeded.fire();
			return false;
		}

		this.log('AutoRetry: triggerRetry() — actively scanning for retry buttons...');
		const found = await this.monitor.findAndClickRetry();

		if (found) {
			this.retryCount++;
			this.totalRetries++;
			this.globalRetryCount++;
			if (this.globalWindowStart === 0) {
				this.globalWindowStart = Date.now();
			}
			this.lastRetryTime = Date.now();
			this.postClickCooldownUntil = Date.now() + AutoRetry.POST_CLICK_COOLDOWN_MS;
			this.log(`AutoRetry: ✓ Active retry succeeded (attempt ${this.retryCount}/${this.maxAttempts}, global ${this.globalRetryCount})`);
			this._onRetry.fire({ attempt: this.retryCount, maxAttempts: this.maxAttempts });
		} else {
			this.log('AutoRetry: No retry button found in any session');
		}

		return found;
	}

	/**
	 * Handle a detected DOM element.
	 * Routes to error classification handler or retry counting logic.
	 */
	private async handleElement(el: DetectedElement): Promise<void> {
		if (!this.enabled) {
			return;
		}

		// Handle error classifications — adjust wait periods
		if (el.type === 'error-classified') {
			this.handleErrorClassification(el);
			return;
		}

		if (el.type !== 'retry-button' && el.type !== 'continue-button') {
			return;
		}

		// Post-click cooldown: suppress ALL retry events for a period after a successful click.
		// This prevents the rapid detection → click → DOM mutation → re-detection cycle.
		const now = Date.now();
		if (now < this.postClickCooldownUntil) {
			this.log(
				`AutoRetry: Post-click cooldown active (${Math.ceil((this.postClickCooldownUntil - now) / 1000)}s remaining) — suppressing`
			);
			return;
		}

		if (this.clickInProgress) {
			return; // Prevent concurrent click attempts
		}

		this.log(
			`AutoRetry: Event received type="${el.type}" retryCount=${this.retryCount}/${this.maxAttempts} ` +
				`global=${this.globalRetryCount} gen=${this.resetGeneration} ` +
				`timeSinceLastRetry=${Date.now() - this.lastRetryTime}ms` +
				(this.waitUntil > Date.now() ? ` WAITING ${this.waitUntil - Date.now()}ms` : '')
		);

		// Check global cap first
		if (this.checkGlobalCap()) {
			this.log('AutoRetry: Retry suppressed — global cap reached');
			this._onMaxRetriesExceeded.fire();
			return;
		}

		// Check if we're in a "wait" period due to rate limiting or other errors
		if (now < this.waitUntil) {
			const remainingMs = this.waitUntil - now;
			this.log(`AutoRetry: Retry suppressed — error-imposed wait period (${Math.ceil(remainingMs / 1000)}s remaining)`);
			return;
		}

		// Exponential backoff: interval grows with consecutive failures AND across resets
		const backoffMs = this.computeBackoff();
		if (now - this.lastRetryTime < backoffMs) {
			this.log(
				`AutoRetry: Backoff (${now - this.lastRetryTime}ms < ${Math.round(backoffMs)}ms ` +
					`[base=${this.delayMs}ms × 2^${Math.max(0, this.retryCount - 1)} × gen=${(1 + this.resetGeneration * 0.5).toFixed(1)} + jitter])`
			);
			return;
		}

		// Check max retries
		if (this.retryCount >= this.maxAttempts) {
			this.log(`AutoRetry: Max attempts (${this.maxAttempts}) reached, stopping`);
			this._onMaxRetriesExceeded.fire();
			return;
		}

		this.clickInProgress = true;
		try {
			this.log('AutoRetry: Safety checks passed — actively triggering click via DOMMonitor...');
			const clicked = await this.monitor.findAndClickRetry();
			
			if (!clicked) {
				this.log('AutoRetry: Failed to find and click retry button despite detection event');
				return;
			}
		} finally {
			this.clickInProgress = false;
		}

		this.retryCount++;
		this.totalRetries++;
		this.globalRetryCount++;
		if (this.globalWindowStart === 0) {
			this.globalWindowStart = now;
		}
		this.lastRetryTime = now;
		this.postClickCooldownUntil = now + AutoRetry.POST_CLICK_COOLDOWN_MS;

		this.log(
			`AutoRetry: ✓ ${el.type === 'continue-button' ? 'Continue' : 'Retry'} clicked ` +
				`(attempt ${this.retryCount}/${this.maxAttempts}, global ${this.globalRetryCount})`
		);
		this._onRetry.fire({ attempt: this.retryCount, maxAttempts: this.maxAttempts });
	}

	/**
	 * Handle classified error events — set appropriate wait periods.
	 * This prevents the observer from immediately retrying during rate limits,
	 * which would make the problem worse.
	 */
	private handleErrorClassification(
		el: Extract<DetectedElement, { type: 'error-classified' }>
	): void {
		const waitMs = AutoRetry.ERROR_WAIT_MS[el.errorCategory];

		switch (el.errorCategory) {
			case 'rate-limited':
				this.waitUntil = Date.now() + waitMs;
				this.log(
					`AutoRetry: ⏸ Rate limited — pausing retries for ${waitMs / 1000}s. ` +
						`DO NOT retry during this window (would worsen the limit). ` +
						`Text: "${el.text.substring(0, 80)}"`
				);
				break;

			case 'capacity-exhausted':
				this.waitUntil = Date.now() + waitMs;
				this.log(
					`AutoRetry: ⏸ Capacity exhausted — pausing retries for ${waitMs / 1000}s. ` +
						`Text: "${el.text.substring(0, 80)}"`
				);
				break;

			case 'server-error':
				this.waitUntil = Date.now() + waitMs;
				this.log(
					`AutoRetry: ⏸ Server error — pausing retries for ${waitMs / 1000}s. ` +
						`Text: "${el.text.substring(0, 80)}"`
				);
				break;

			case 'agent-terminated':
				// No wait — allow immediate retry
				this.log(
					`AutoRetry: Agent terminated — allowing immediate retry. ` +
						`Text: "${el.text.substring(0, 80)}"`
				);
				break;

			case 'quota-exhausted':
				// Not our concern — ModelRotation handler will handle this
				this.log(
					`AutoRetry: Quota exhausted — deferring to ModelRotation. ` +
						`Text: "${el.text.substring(0, 80)}"`
				);
				break;
		}
	}

	dispose(): void {
		this._onRetry.dispose();
		this._onMaxRetriesExceeded.dispose();
	}
}

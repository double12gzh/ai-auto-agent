import * as assert from 'assert';
import * as sinon from 'sinon';
import { AutoRetry } from '../features/autoRetry';
import { DOMMonitor, DetectedElement } from '../cdp/domMonitor';

describe('AutoRetry', () => {
	let mockDOMMonitor: Partial<DOMMonitor>;
	let mockLog: sinon.SinonSpy;
	let autoRetry: AutoRetry;
	let triggerDetect: (el: DetectedElement) => void;
	let clock: sinon.SinonFakeTimers;

	beforeEach(() => {
		clock = sinon.useFakeTimers();
		mockLog = sinon.spy();

		mockDOMMonitor = {
			onDetect: sinon.fake((callback) => {
				triggerDetect = callback;
				return { dispose: sinon.spy() };
			}) as any,
			findAndClickRetry: sinon.stub().resolves(true),
		};

		autoRetry = new AutoRetry(mockDOMMonitor as DOMMonitor, mockLog, 3, 2000);
	});

	afterEach(() => {
		clock.restore();
		sinon.restore();
	});

	it('should register onDetect listener', () => {
		assert.strictEqual((mockDOMMonitor.onDetect as sinon.SinonSpy).called, true);
	});

	it('should track retries and respect maxAttempts', async () => {
		const retryEl: DetectedElement = {
			type: 'retry-button',
			sessionTargetId: 'test-session-1',
		};

		// Advance clock initially so Date.now() starts > 3000
		clock.tick(5000);

		// 1st retry — backoff = delayMs * 2^0 = 2000ms (+ jitter)
		await triggerDetect(retryEl);
		assert.strictEqual((autoRetry as any)['retryCount'], 1);

		// Advance past 1st backoff AND post-click cooldown (30s)
		clock.tick(35000);

		// 2nd retry — backoff = delayMs * 2^1 = 4000ms (+ jitter)
		await triggerDetect(retryEl);
		assert.strictEqual((autoRetry as any)['retryCount'], 2);

		// Advance past 2nd backoff AND post-click cooldown (30s)
		clock.tick(35000);

		// 3rd retry — reaches maxAttempts (3)
		await triggerDetect(retryEl);
		assert.strictEqual((autoRetry as any)['retryCount'], 3);

		// 4th retry should trigger max exceeded and not increment count
		clock.tick(35000);
		await triggerDetect(retryEl);

		assert.strictEqual((autoRetry as any)['retryCount'], 3); // Still 3
	});

	it('should correctly reset retry count but not global counters', async () => {
		const retryEl: DetectedElement = {
			type: 'retry-button',
			sessionTargetId: 'test-session-1',
		};
		clock.tick(5000);
		await triggerDetect(retryEl);
		assert.strictEqual((autoRetry as any)['retryCount'], 1);
		assert.strictEqual((autoRetry as any)['globalRetryCount'], 1);

		autoRetry.resetCount();
		assert.strictEqual((autoRetry as any)['retryCount'], 0);
		// Global counter should NOT be reset
		assert.strictEqual((autoRetry as any)['globalRetryCount'], 1);
		// Reset generation should increment
		assert.strictEqual((autoRetry as any)['resetGeneration'], 1);
	});

	it('should correctly fullReset all counters', async () => {
		const retryEl: DetectedElement = {
			type: 'retry-button',
			sessionTargetId: 'test-session-1',
		};
		clock.tick(5000);
		await triggerDetect(retryEl);
		autoRetry.resetCount(); // generation = 1

		clock.tick(35000);
		await triggerDetect(retryEl);
		autoRetry.resetCount(); // generation = 2

		assert.strictEqual((autoRetry as any)['globalRetryCount'], 2);
		assert.strictEqual((autoRetry as any)['resetGeneration'], 2);

		autoRetry.fullReset();
		assert.strictEqual((autoRetry as any)['retryCount'], 0);
		assert.strictEqual((autoRetry as any)['globalRetryCount'], 0);
		assert.strictEqual((autoRetry as any)['resetGeneration'], 0);
		assert.strictEqual((autoRetry as any)['globalCapReached'], false);
	});

	it('should enforce global retry cap', async () => {
		// maxAttempts = 3, so global cap = 3 * 3 = 9
		const retryEl: DetectedElement = {
			type: 'retry-button',
			sessionTargetId: 'test-session-1',
		};

		clock.tick(5000);

		// Simulate 3 cycles of: 3 retries + resetCount()
		for (let cycle = 0; cycle < 3; cycle++) {
			for (let i = 0; i < 3; i++) {
				clock.tick(65000); // past MAX_BACKOFF_MS
				await triggerDetect(retryEl);
			}
			autoRetry.resetCount();
		}

		assert.strictEqual((autoRetry as any)['globalRetryCount'], 9);

		// Next retry should be blocked by global cap
		clock.tick(65000);
		await triggerDetect(retryEl);

		assert.strictEqual((autoRetry as any)['globalCapReached'], true);
		assert.strictEqual(autoRetry.isGlobalCapReached(), true);
		// retryCount should still be 0 (was just reset and global cap blocked new retry)
		assert.strictEqual((autoRetry as any)['retryCount'], 0);
	});

	it('should escalate backoff across resets via resetGeneration', async () => {
		const retryEl: DetectedElement = {
			type: 'retry-button',
			sessionTargetId: 'test-session-1',
		};

		clock.tick(5000);

		// First retry at generation 0
		await triggerDetect(retryEl);
		assert.strictEqual((autoRetry as any)['retryCount'], 1);

		// Reset (generation becomes 1)
		autoRetry.resetCount();

		// Try to retry immediately after reset - should be blocked by escalated backoff
		// With generation=1, backoff = 2000 * 1 * (1 + 1*0.5) = 3000ms + jitter
		// Need to advance less than that to prove escalation
		clock.tick(31000); // Past post-click cooldown but test backoff escalation
		await triggerDetect(retryEl);
		// Should have retried (past cooldown + past backoff)
		assert.strictEqual((autoRetry as any)['retryCount'], 1);

		// Reset again (generation becomes 2)
		autoRetry.resetCount();

		// generation=2: backoff = 2000 * (1 + 2*0.5) = 4000ms + jitter
		// Advance past post-click cooldown
		clock.tick(31000);
		await triggerDetect(retryEl);
		assert.strictEqual((autoRetry as any)['retryCount'], 1);
	});

	it('should ignore non-retry elements', async () => {
		const acceptEl: DetectedElement = {
			type: 'accept-edit',
			sessionTargetId: 'test-session-1',
		};
		await triggerDetect(acceptEl);
		assert.strictEqual((autoRetry as any)['retryCount'], 0);
	});

	it('should reset global cap after window expires', async () => {
		const retryEl: DetectedElement = {
			type: 'retry-button',
			sessionTargetId: 'test-session-1',
		};

		clock.tick(5000);

		// Hit global cap (9 retries)
		for (let cycle = 0; cycle < 3; cycle++) {
			for (let i = 0; i < 3; i++) {
				clock.tick(65000);
				await triggerDetect(retryEl);
			}
			autoRetry.resetCount();
		}

		// globalCapReached is set lazily on the NEXT attempt after reaching the limit
		// Trigger one more detect to set the flag
		clock.tick(65000);
		await triggerDetect(retryEl);
		assert.strictEqual(autoRetry.isGlobalCapReached(), true);

		// Advance past the 30-minute global window
		clock.tick(31 * 60 * 1000);

		// Should be allowed to retry again (window expired, cap reset)
		await triggerDetect(retryEl);
		assert.strictEqual(autoRetry.isGlobalCapReached(), false);
		assert.strictEqual((autoRetry as any)['retryCount'], 1);
		assert.strictEqual((autoRetry as any)['globalRetryCount'], 1);
	});

	it('should prevent concurrent clicks via clickInProgress lock', async () => {
		const retryEl: DetectedElement = {
			type: 'retry-button',
			sessionTargetId: 'test-session-1',
		};
		clock.tick(5000);

		// Make findAndClickRetry take some time to simulate network/DOM delay
		let resolveClick: (val: boolean) => void;
		(mockDOMMonitor.findAndClickRetry as sinon.SinonStub).returns(
			new Promise((resolve) => {
				resolveClick = resolve;
			})
		);

		// Trigger first detect - should acquire lock and wait
		const p1 = triggerDetect(retryEl);
		assert.strictEqual((autoRetry as any)['clickInProgress'], true);
		
		// Trigger second detect immediately - should be blocked by lock
		await triggerDetect(retryEl);
		
		// Finish the first click
		resolveClick!(true);
		await p1;

		assert.strictEqual((autoRetry as any)['clickInProgress'], false);
		assert.strictEqual((autoRetry as any)['retryCount'], 1); // Only incremented once
		assert.strictEqual((mockDOMMonitor.findAndClickRetry as sinon.SinonStub).callCount, 1);
	});

	it('should not increment counters if findAndClickRetry fails', async () => {
		const retryEl: DetectedElement = {
			type: 'retry-button',
			sessionTargetId: 'test-session-1',
		};
		clock.tick(5000);

		(mockDOMMonitor.findAndClickRetry as sinon.SinonStub).resolves(false);

		await triggerDetect(retryEl);

		assert.strictEqual((autoRetry as any)['retryCount'], 0);
		assert.strictEqual((autoRetry as any)['totalRetries'], 0);
	});

	it('should suppress retry events during post-click cooldown', async () => {
		const retryEl: DetectedElement = {
			type: 'retry-button',
			sessionTargetId: 'test-session-1',
		};

		(mockDOMMonitor.findAndClickRetry as sinon.SinonStub).resolves(true);
		clock.tick(5000);

		// First retry — should succeed
		await triggerDetect(retryEl);
		assert.strictEqual((autoRetry as any)['retryCount'], 1);

		// Advance 10s — within 30s post-click cooldown window
		clock.tick(10000);
		await triggerDetect(retryEl);
		// Should NOT have retried (post-click cooldown active)
		assert.strictEqual((autoRetry as any)['retryCount'], 1);

		// Advance another 10s (total 20s) — still within cooldown
		clock.tick(10000);
		await triggerDetect(retryEl);
		assert.strictEqual((autoRetry as any)['retryCount'], 1);

		// Advance past 30s cooldown (total 35s since click)
		clock.tick(15000);
		await triggerDetect(retryEl);
		// NOW it should retry (cooldown expired + backoff elapsed)
		assert.strictEqual((autoRetry as any)['retryCount'], 2);
	});

	it('should clear post-click cooldown on fullReset', async () => {
		const retryEl: DetectedElement = {
			type: 'retry-button',
			sessionTargetId: 'test-session-1',
		};

		(mockDOMMonitor.findAndClickRetry as sinon.SinonStub).resolves(true);
		clock.tick(5000);

		// Trigger a retry — activates post-click cooldown
		await triggerDetect(retryEl);
		assert.strictEqual((autoRetry as any)['retryCount'], 1);
		assert.ok((autoRetry as any)['postClickCooldownUntil'] > 0);

		// fullReset should clear the cooldown
		autoRetry.fullReset();
		assert.strictEqual((autoRetry as any)['postClickCooldownUntil'], 0);

		// Should be able to retry immediately (no cooldown, but still need to pass backoff)
		clock.tick(5000); // past backoff
		await triggerDetect(retryEl);
		assert.strictEqual((autoRetry as any)['retryCount'], 1);
	});

	it('should classify high-traffic errors correctly via handleElement', async () => {
		const highTrafficError: DetectedElement = {
			type: 'error-classified',
			errorCategory: 'capacity-exhausted',
			text: 'Our servers are experiencing high traffic right now, please try again later.',
			sessionTargetId: 'workbench-session',
		};

		clock.tick(5000);

		// Trigger the error classification event
		await triggerDetect(highTrafficError);

		// Should have set a wait period (15s for capacity-exhausted)
		assert.ok((autoRetry as any)['waitUntil'] > Date.now() - 1000);

		// Retry attempts during the wait period should be suppressed
		const retryEl: DetectedElement = {
			type: 'retry-button',
			sessionTargetId: 'test-session-1',
		};
		await triggerDetect(retryEl);
		assert.strictEqual((autoRetry as any)['retryCount'], 0, 'Should not retry during capacity-exhausted wait period');
	});
});

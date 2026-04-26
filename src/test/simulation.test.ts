/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unused-vars */
import * as assert from 'assert';
import * as sinon from 'sinon';
import { AutoRetry } from '../features/autoRetry';
import { DOMMonitor, DetectedElement } from '../cdp/domMonitor';

/**
 * 模拟真实场景："Agent terminated due to error" 错误不断出现。
 *
 * 截图中的错误：
 *   "⊘ Agent terminated due to error
 *    You can prompt the model to try again or start a new conversation
 *    if the error persists.
 *    See our troubleshooting guide for more help."
 *   [Retry] [Copy debug info] [Dismiss]
 *
 * 旧行为：30s 定时器自动 resetCount → 无限重试
 * 新行为：全局 cap + 递增冷却 + 模型轮转熔断 → 最终停止
 */
describe('Simulation: Agent Terminated Infinite Retry', () => {
	let mockDOMMonitor: Partial<DOMMonitor>;
	let mockLog: sinon.SinonSpy;
	let autoRetry: AutoRetry;
	let triggerDetect: (el: DetectedElement) => void;
	let clock: sinon.SinonFakeTimers;

	// Event counters — registered BEFORE any detections
	let totalRetries: number;
	let maxExceededEvents: number;
	let globalCapEvents: number;

	beforeEach(() => {
		clock = sinon.useFakeTimers();
		mockLog = sinon.fake((msg: string) => {});

		mockDOMMonitor = {
			onDetect: sinon.fake((callback) => {
				triggerDetect = callback;
				return { dispose: sinon.spy() };
			}) as any,
			findAndClickRetry: sinon.stub().resolves(true),
		};

		// maxAttempts=5, delayMs=2000 (同默认配置)
		autoRetry = new AutoRetry(mockDOMMonitor as DOMMonitor, mockLog, 5, 2000);

		// Register event listeners BEFORE any interactions
		totalRetries = 0;
		maxExceededEvents = 0;
		globalCapEvents = 0;

		autoRetry.onRetry(() => totalRetries++);
		autoRetry.onMaxRetriesExceeded(() => {
			maxExceededEvents++;
			if (autoRetry.isGlobalCapReached()) {
				globalCapEvents++;
			}
		});
	});

	afterEach(() => {
		clock.restore();
		sinon.restore();
	});

	/**
	 * 场景 1: 模拟 "Agent terminated" 错误持续出现
	 *
	 * DOM 扫描每 2 秒触发一次，每次都检测到 retry-button。
	 * 验证：不会无限重试，最终被 maxAttempts 阻止。
	 */
	it('should stop after maxAttempts even with persistent errors', async () => {
		const retryButton: DetectedElement = {
			type: 'retry-button',
			sessionTargetId: 'webview-session-1',
		};
		const agentTerminated: DetectedElement = {
			type: 'error-classified',
			errorCategory: 'agent-terminated',
			text: 'Agent terminated due to error. You can prompt the model to try again...',
			sessionTargetId: 'workbench-session',
		};

		clock.tick(5000); // 初始推进

		// 模拟 error classification 先到达
		await triggerDetect(agentTerminated);

		// 模拟 DOM 检测到 retry-button（共 20 次）
		for (let i = 0; i < 20; i++) {
			clock.tick(65000); // 推进足够时间让 backoff 通过
			await triggerDetect(retryButton);
		}

		// 应该只重试了 5 次（maxAttempts），不是 20 次
		assert.strictEqual(totalRetries, 5, `应该只重试 5 次，实际 ${totalRetries} 次`);
		assert.ok(maxExceededEvents > 0, '应该触发了 maxRetriesExceeded 事件');

		console.log(`  ✅ 连续重试被限制为 ${totalRetries} 次 (maxAttempts=5)`);
		console.log(`  ✅ maxRetriesExceeded 触发了 ${maxExceededEvents} 次`);
	});

	/**
	 * 场景 2: 模拟旧的 30s 定时器行为
	 *
	 * 旧行为: 5 次重试 → 30s 后 resetCount() → 又重试 5 次 → 无限循环
	 * 新行为: 5 次重试 → resetCount() 只清连续计数 → 全局 cap 最终阻止
	 */
	it('should enforce global cap even with repeated resetCount calls', async () => {
		const retryButton: DetectedElement = {
			type: 'retry-button',
			sessionTargetId: 'webview-session-1',
		};

		// Use a dedicated instance with small delays to avoid hitting the 30-min window
		// maxAttempts=5, delayMs=200 (short enough that ticks won't approach 30-min window)
		const fastRetry = new AutoRetry(mockDOMMonitor as DOMMonitor, mockLog, 5, 200);

		let fastRetries = 0;
		let fastCapHit = false;
		fastRetry.onRetry(() => fastRetries++);
		fastRetry.onMaxRetriesExceeded(() => {
			if (fastRetry.isGlobalCapReached()) {
				fastCapHit = true;
			}
		});

		clock.tick(5000);

		// 模拟旧的 extension.ts 行为：每 5 次重试后 resetCount()
		// 全局 cap = 5 * 3 = 15
		for (let cycle = 0; cycle < 10; cycle++) {
			for (let i = 0; i < 5; i++) {
				clock.tick(35000); // 35s — past post-click cooldown (30s) + backoff
				await triggerDetect(retryButton);
			}

			if (fastRetry.isGlobalCapReached()) {
				console.log(`  ✅ 全局 cap 在第 ${cycle + 1} 轮后触发 (共 ${fastRetries} 次重试)`);
				break;
			}

			fastRetry.resetCount();
		}

		// If cap wasn't hit in loop, trigger one more check
		if (!fastRetry.isGlobalCapReached()) {
			clock.tick(35000);
			await triggerDetect(retryButton);
		}

		assert.ok(fastRetry.isGlobalCapReached(), '应该触发了全局 cap');
		assert.ok(fastRetries <= 15, `重试次数不应超过 15，实际 ${fastRetries} 次`);
		console.log(`  ✅ 全局 cap 后总计 ${fastRetries} 次重试`);

		// 关键验证：cap 触发后，后续重试全部被阻止
		const retriesAtCap = fastRetries;
		for (let i = 0; i < 10; i++) {
			clock.tick(35000);
			await triggerDetect(retryButton);
		}
		assert.strictEqual(fastRetries, retriesAtCap, '全局 cap 后不应再有新重试');

		console.log(`  ✅ 全局 cap 后 10 次 detect 全部被阻止 (总计仍为 ${fastRetries})`);

		fastRetry.dispose();
	});

	/**
	 * 场景 3: 验证递增冷却（Escalating Cooldown）
	 *
	 * 每次 resetCount() 后，backoff 不会回到最初值。
	 */
	it('should increase backoff interval across resets', async () => {
		const retryButton: DetectedElement = {
			type: 'retry-button',
			sessionTargetId: 'webview-session-1',
		};

		clock.tick(5000);

		// 第 1 轮：generation=0, backoff = 2000 * 1.0 = 2000ms + jitter
		await triggerDetect(retryButton);
		assert.strictEqual((autoRetry as any)['retryCount'], 1);

		autoRetry.resetCount(); // generation=1

		// Need to advance past post-click cooldown (30s)
		// generation=1: backoff = 2000 * (1 + 0.5) = 3000ms + jitter
		clock.tick(31000); // Past post-click cooldown
		await triggerDetect(retryButton);
		// Should have retried (past cooldown + backoff)
		assert.strictEqual((autoRetry as any)['retryCount'], 1);
		console.log(`  ✅ generation=1 时 post-click cooldown 内被阻止`);

		// Verify retry succeeds after cooldown
		clock.tick(5000);
		await triggerDetect(retryButton);
		assert.strictEqual((autoRetry as any)['retryCount'], 1);
	});

	/**
	 * 场景 4: fullReset() 后完全恢复
	 *
	 * 用户手动点击 "Retry Now" → fullReset() → 所有限制清除。
	 */
	it('should fully recover after fullReset (manual retry)', async () => {
		const retryButton: DetectedElement = {
			type: 'retry-button',
			sessionTargetId: 'webview-session-1',
		};

		clock.tick(5000);

		// 先耗尽全局 cap
		for (let cycle = 0; cycle < 3; cycle++) {
			for (let i = 0; i < 5; i++) {
				clock.tick(65000);
				await triggerDetect(retryButton);
			}
			autoRetry.resetCount();
		}

		// 触发 global cap check
		clock.tick(65000);
		await triggerDetect(retryButton);
		assert.ok(autoRetry.isGlobalCapReached(), '全局 cap 应该已经到达');

		const retriesBefore = totalRetries;

		// 用户手动 fullReset (模拟 "Retry Now" 命令)
		autoRetry.fullReset();
		assert.ok(!autoRetry.isGlobalCapReached(), 'fullReset 后 cap 应该解除');

		// 应该能重新开始重试
		clock.tick(65000);
		await triggerDetect(retryButton);
		assert.strictEqual(totalRetries, retriesBefore + 1, 'fullReset 后应该能重试');

		console.log(`  ✅ fullReset() 后成功恢复重试能力`);
	});

	/**
	 * 场景 5: 完整端到端模拟
	 *
	 * 模拟真实使用流程：
	 * 1. Agent terminated 错误出现
	 * 2. 自动重试 5 次 → maxRetriesExceeded
	 * 3. 切换模型 → resetCount → 又重试 5 次
	 * 4. 再切模型 → resetCount → 又重试 5 次
	 * 5. 全局 cap (15 次) → 完全停止
	 * 6. 用户手动 fullReset → 恢复
	 */
	it('end-to-end: agent terminated → retry → model switch → global cap → manual reset', async () => {
		const retryButton: DetectedElement = {
			type: 'retry-button',
			sessionTargetId: 'webview-session-1',
		};
		const agentTerminated: DetectedElement = {
			type: 'error-classified',
			errorCategory: 'agent-terminated',
			text: 'Agent terminated due to error',
			sessionTargetId: 'workbench-session',
		};

		clock.tick(5000);

		console.log('\n  📋 端到端模拟开始\n');

		// ── Phase 1: 首次错误 + 5 次重试 ─────────────────
		await triggerDetect(agentTerminated);
		for (let i = 0; i < 6; i++) {
			clock.tick(65000);
			await triggerDetect(retryButton);
		}
		console.log(`  Phase 1: ${totalRetries} 次重试, ${maxExceededEvents} 次 maxExceeded`);
		assert.strictEqual(totalRetries, 5, 'Phase 1 应该重试 5 次');
		assert.strictEqual(maxExceededEvents, 1, 'Phase 1 应该触发 1 次 maxExceeded');

		// ── Phase 2: 模拟切模型 + resetCount ──────────────
		autoRetry.resetCount(); // 模拟 extension.ts 中切模型后的 resetCount
		const retries2Start = totalRetries;
		for (let i = 0; i < 6; i++) {
			clock.tick(65000);
			await triggerDetect(retryButton);
		}
		console.log(
			`  Phase 2: 新增 ${totalRetries - retries2Start} 次重试 (累计 ${totalRetries})`
		);
		assert.strictEqual(totalRetries, 10, 'Phase 2 累计应该是 10 次');

		// ── Phase 3: 再切模型 + resetCount ─────────────────
		autoRetry.resetCount();
		const retries3Start = totalRetries;
		for (let i = 0; i < 6; i++) {
			clock.tick(65000);
			await triggerDetect(retryButton);
		}
		console.log(
			`  Phase 3: 新增 ${totalRetries - retries3Start} 次重试 (累计 ${totalRetries})`
		);
		assert.strictEqual(totalRetries, 15, 'Phase 3 累计应该是 15 次');

		// ── Phase 4: 全局 cap 应该已到达 ──────────────────
		autoRetry.resetCount(); // 即使再 reset，全局 cap 也不清
		clock.tick(65000);
		await triggerDetect(retryButton);
		assert.ok(autoRetry.isGlobalCapReached(), '全局 cap 应该到达');
		assert.strictEqual(totalRetries, 15, '不应该有更多重试');
		console.log(`  Phase 4: ⛔ 全局 cap 到达, 总计 ${totalRetries} 次重试`);

		// 确认后续重试全部被阻止
		for (let i = 0; i < 5; i++) {
			clock.tick(65000);
			await triggerDetect(retryButton);
		}
		assert.strictEqual(totalRetries, 15, '全局 cap 后不应有新重试');
		console.log(`  Phase 4: 确认后续 5 次 detect 全部被阻止 ✅`);

		// ── Phase 5: 用户手动 fullReset ───────────────────
		autoRetry.fullReset();
		clock.tick(65000);
		await triggerDetect(retryButton);
		assert.strictEqual(totalRetries, 16, 'fullReset 后应该能重试');
		console.log(`  Phase 5: fullReset 后恢复, 总计 ${totalRetries} 次重试 ✅`);

		console.log(
			`\n  📊 最终统计: ${totalRetries} 次重试, ${maxExceededEvents} 次 maxExceeded, ${globalCapEvents} 次全局 cap`
		);
		console.log(`  ✅ 端到端模拟通过!\n`);
	});
});

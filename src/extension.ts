import * as vscode from 'vscode';
import { CDPClient } from './cdp/cdpClient';
import { DOMMonitor } from './cdp/domMonitor';
import { AutoRetry } from './features/autoRetry';
import { AutoAccept } from './features/autoAccept';
import { ModelRotation } from './features/modelRotation';

let outputChannel: vscode.OutputChannel;
let statusBarItem: vscode.StatusBarItem;
let cdpClient: CDPClient;
let domMonitor: DOMMonitor;
let autoRetry: AutoRetry;
let autoAccept: AutoAccept;
let modelRotation: ModelRotation;
let enabled = true;

function log(msg: string): void {
	const ts = new Date().toISOString();
	outputChannel?.appendLine(`${ts} ${msg}`);
}

function getConfig() {
	const cfg = vscode.workspace.getConfiguration('ai-auto-agent');
	return {
		enabled: cfg.get<boolean>('enabled', true),
		cdpPort: cfg.get<number>('cdpPort', 9333),
		autoRetry: cfg.get<boolean>('autoRetry', true),
		autoRetryMaxAttempts: cfg.get<number>('autoRetryMaxAttempts', 5),
		autoRetryDelayMs: cfg.get<number>('autoRetryDelayMs', 2000),
		autoAccept: cfg.get<boolean>('autoAccept', false),
		dangerousCommands: cfg.get<string[]>('dangerousCommands', []),
		modelRotation: cfg.get<boolean>('modelRotation', true),
		modelList: cfg.get<string[]>('modelList', []),
	};
}

export function activate(context: vscode.ExtensionContext) {
	outputChannel = vscode.window.createOutputChannel('AI Auto Agent');
	context.subscriptions.push(outputChannel);

	const config = getConfig();
	enabled = config.enabled;

	// ── Status Bar ─────────────────────────────────────────────────
	statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	statusBarItem.command = 'ai-auto-agent.toggle';
	updateStatusBar('connecting');
	statusBarItem.show();
	context.subscriptions.push(statusBarItem);

	// ── CDP + DOM Monitor ──────────────────────────────────────────
	cdpClient = new CDPClient(config.cdpPort, log);
	domMonitor = new DOMMonitor(cdpClient, log);
	context.subscriptions.push(cdpClient);

	// Update status bar when CDP sessions change
	cdpClient.onStatusChange = () => {
		if (enabled) {
			const count = cdpClient.sessionCount;
			if (count > 0) {
				updateStatusBar('active', `${count} session(s)`);
			} else {
				updateStatusBar('connecting');
			}
		}
	};

	// ── Features ───────────────────────────────────────────────────
	autoRetry = new AutoRetry(
		domMonitor,
		log,
		config.autoRetryMaxAttempts,
		config.autoRetryDelayMs
	);
	autoRetry.setEnabled(config.autoRetry && enabled);

	autoAccept = new AutoAccept(domMonitor, log, config.dangerousCommands);
	autoAccept.setEnabled(config.autoAccept && enabled);

	modelRotation = new ModelRotation(domMonitor, cdpClient, log, config.modelList);
	modelRotation.setEnabled(config.modelRotation && enabled);

	context.subscriptions.push(autoRetry, autoAccept, modelRotation);

	// ── Feature Event Handlers ─────────────────────────────────────

	domMonitor.onDetect((el) => {
		if (el.type === 'emergency-stop') {
			updateStatusBar('error');
			vscode.window
				.showErrorMessage(
					`⛔ AI Auto Agent: Emergency Stop Activated. ${el.reason}. ` +
						`All automatic interactions have been paused to prevent infinite loops.`,
					'Reset & Resume'
				)
				.then((selection) => {
					if (selection === 'Reset & Resume') {
						autoRetry.fullReset();
						domMonitor.setPaused(false);
						vscode.window.showInformationMessage('▶️ AI Auto Agent: Resumed');
						updateStatusBar('active', `${cdpClient.sessionCount} session(s)`);
					}
				});
		}
	});

	autoRetry.onRetry(({ attempt, maxAttempts }) => {
		updateStatusBar('retrying', `Retry ${attempt}/${maxAttempts}`);
	});

	autoRetry.onMaxRetriesExceeded(() => {
		log('AutoRetry: Max retries exceeded — evaluating next step');

		// Circuit breaker: if global cap reached, stop everything
		if (autoRetry.isGlobalCapReached()) {
			log('AutoRetry: ⛔ Global cap reached — all retries suppressed');
			updateStatusBar('error');
			vscode.window.showWarningMessage(
				`⛔ AI Auto Agent: Global retry limit reached. ` +
					`All automatic retries have been paused. Use "Retry Now" command to manually retry.`
			);
			return;
		}

		if (config.modelRotation) {
			// Check if model rotation has completed a full cycle
			if (modelRotation.hasCompletedCycle()) {
				log('AutoRetry: All models have been tried — stopping rotation');
				updateStatusBar('error');
				vscode.window.showWarningMessage(
					`⚠️ AI Auto Agent: All models have been tried (${config.autoRetryMaxAttempts} attempts each). ` +
						`Please check the error and retry manually.`
				);
			} else {
				modelRotation.switchToNext().then(() => {
					autoRetry.resetCount(); // Only resets consecutive counter, not global
				});
			}
		} else {
			vscode.window.showWarningMessage(
				`⚠️ AI Auto Agent: Retry limit reached (${config.autoRetryMaxAttempts} attempts). ` +
					`Please try switching models manually.`
			);
		}
	});

	modelRotation.onSwitch(({ to }) => {
		updateStatusBar('active', `Model: ${to}`);
		autoRetry.resetCount();
	});

	// ── Commands ───────────────────────────────────────────────────
	context.subscriptions.push(
		vscode.commands.registerCommand('ai-auto-agent.toggle', () => {
			enabled = !enabled;
			autoRetry.setEnabled(config.autoRetry && enabled);
			autoAccept.setEnabled(config.autoAccept && enabled);
			modelRotation.setEnabled(config.modelRotation && enabled);

			if (enabled) {
				const count = cdpClient.sessionCount;
				if (count > 0) {
					updateStatusBar('active', `${count} session(s)`);
				} else {
					updateStatusBar('connecting');
				}
				domMonitor.start();
				vscode.window.showInformationMessage('✅ AI Auto Agent: Enabled');
			} else {
				updateStatusBar('disabled');
				domMonitor.stop();
				vscode.window.showInformationMessage('⏸️ AI Auto Agent: Disabled');
			}
		}),

		vscode.commands.registerCommand('ai-auto-agent.retryNow', async () => {
			log('Manual retry triggered — full reset');
			autoRetry.fullReset();
			modelRotation.resetCycle();
			const found = await autoRetry.triggerRetry();
			if (found) {
				vscode.window.showInformationMessage(
					'🔄 AI Auto Agent: Retry triggered successfully'
				);
			} else {
				vscode.window.showWarningMessage(
					'❌ AI Auto Agent: No retry button found. Make sure an error dialog is visible.'
				);
			}
		}),

		vscode.commands.registerCommand('ai-auto-agent.switchModel', async () => {
			modelRotation.resetCycle(); // Manual switch resets the cycle tracker
			const switched = await modelRotation.switchToNext();
			if (switched) {
				autoRetry.resetCount();
			}
		}),

		vscode.commands.registerCommand('ai-auto-agent.simulateError', async () => {
			if (cdpClient.sessionCount === 0) {
				vscode.window.showErrorMessage(
					'No active sessions. Please open an agent panel first.'
				);
				return;
			}

			const errorTypes = [
				{
					label: '$(error) Agent Terminated',
					description: 'agent-terminated — triggers immediate retry',
					value: 'agent-terminated' as const,
				},
				{
					label: '$(warning) Rate Limited (429)',
					description: 'rate-limited — triggers 30s wait, no model switch',
					value: 'rate-limited' as const,
				},
				{
					label: '$(circle-slash) Quota Exhausted',
					description: 'quota-exhausted — triggers model rotation',
					value: 'quota-exhausted' as const,
				},
				{
					label: '$(server) Server Error (503)',
					description: 'server-error — triggers 20s wait then retry',
					value: 'server-error' as const,
				},
			];

			const picked = await vscode.window.showQuickPick(errorTypes, {
				placeHolder: 'Select error type to simulate',
				title: '🧪 Simulate Error Dialog',
			});

			if (!picked) return;

			const injected = await domMonitor.injectMockErrorDialog(picked.value);
			if (injected) {
				vscode.window.showInformationMessage(
					`🧪 Mock "${picked.label}" dialog injected. Watch Output panel for auto-retry behavior.`
				);
			} else {
				vscode.window.showWarningMessage(
					'🧪 Failed to inject mock dialog. No suitable session found.'
				);
			}
		}),

		vscode.commands.registerCommand('ai-auto-agent.selectModels', async () => {
			if (cdpClient.sessionCount === 0) {
				vscode.window.showErrorMessage(
					'No active Agent Panel found. Please open an agent panel first.'
				);
				return;
			}

			// Show loading progress
			vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: 'Fetching available models from Agent Panel...',
					cancellable: false,
				},
				async () => {
					try {
						const models = await modelRotation.fetchAvailableModels();
						if (models.length === 0) {
							vscode.window.showWarningMessage(
								'Could not find model dropdown in the Agent Panel.'
							);
							return;
						}

						// Get previously selected models to pre-check them
						const currentSelection = getConfig().modelList;

						const quickPickItems: vscode.QuickPickItem[] = models.map((m) => ({
							label: m,
							picked: currentSelection.some((sel) =>
								m.toLowerCase().includes(sel.toLowerCase())
							),
						}));

						const result = await vscode.window.showQuickPick(quickPickItems, {
							canPickMany: true,
							title: 'Select Models for Auto Rotation',
							placeHolder: 'Checked models will be rotated when quota is exhausted',
						});

						if (result !== undefined) {
							// Save back to configuration
							const selectedModels = result.map((m) => m.label);
							const workspaceConfig =
								vscode.workspace.getConfiguration('ai-auto-agent');
							await workspaceConfig.update(
								'modelList',
								selectedModels,
								vscode.ConfigurationTarget.Global
							);

							vscode.window.showInformationMessage(
								`✅ AI Auto Agent: Saved ${selectedModels.length} models for rotation.`
							);
						}
					} catch (err) {
						vscode.window.showErrorMessage(
							`Failed to fetch models: ${err instanceof Error ? err.message : String(err)}`
						);
					}
				}
			);
		}),

		vscode.commands.registerCommand('ai-auto-agent.debugModelSelector', async () => {
			if (cdpClient.sessionCount === 0) {
				vscode.window.showErrorMessage(
					'No active Agent Panel found. Please open an agent panel first.'
				);
				return;
			}

			vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: 'Scanning DOM for model selectors...',
					cancellable: false,
				},
				async () => {
					const report = await modelRotation.dumpModelSelectorDOM();
					outputChannel.appendLine('\n── Model Selector DOM Debug ──');
					outputChannel.appendLine(report);
					outputChannel.appendLine('── End Debug ──\n');
					outputChannel.show();
					vscode.window.showInformationMessage(
						'🔍 Model selector DOM dump written to Output panel.'
					);
				}
			);
		}),

		vscode.commands.registerCommand('ai-auto-agent.showDashboard', () => {
			const sessionCount = cdpClient.sessionCount;
			const stats = [
				`**AI Auto Agent Dashboard**`,
				``,
				`Status: ${enabled ? '✅ Active' : '⏸️ Disabled'}`,
				`CDP: ${sessionCount > 0 ? `🟢 Connected (${sessionCount} session(s))` : '🔴 Disconnected'}`,
				``,
				`**Features:**`,
				`- Auto Retry: ${config.autoRetry ? 'ON' : 'OFF'} (${autoRetry.totalRetries} retries)`,
				`- Auto Accept: ${config.autoAccept ? 'ON' : 'OFF'} (${autoAccept.totalAccepts} accepts, ${autoAccept.totalBlocked} blocked)`,
				`- Model Rotation: ${config.modelRotation ? 'ON' : 'OFF'} (${modelRotation.totalSwitches} switches)`,
				``,
				`Current Model: ${modelRotation.getCurrentModel()}`,
				`Next Model: ${modelRotation.getNextModel()}`,
			].join('\n');

			outputChannel.appendLine('\n' + stats);
			outputChannel.show();
		})
	);

	// ── Config Change Listener ─────────────────────────────────────
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration('ai-auto-agent')) {
				const newConfig = getConfig();
				enabled = newConfig.enabled;
				autoRetry.setEnabled(newConfig.autoRetry && enabled);
				autoRetry.updateConfig(newConfig.autoRetryMaxAttempts, newConfig.autoRetryDelayMs);
				autoAccept.setEnabled(newConfig.autoAccept && enabled);
				autoAccept.updateDangerousCommands(newConfig.dangerousCommands);
				modelRotation.setEnabled(newConfig.modelRotation && enabled);
				modelRotation.updateModelList(newConfig.modelList);
				updateStatusBar(enabled ? 'active' : 'disabled');
				log('Config reloaded');
			}
		})
	);

	// ── Start ──────────────────────────────────────────────────────
	startCDP(config.cdpPort);
}

async function startCDP(port: number): Promise<void> {
	log(`Connecting to CDP on port ${port}...`);
	const ok = await cdpClient.connect();

	if (ok) {
		const count = cdpClient.sessionCount;
		log(`CDP connected — ${count} webview session(s) found. Starting DOM monitor.`);
		updateStatusBar('active', `${count} session(s)`);
		if (enabled) {
			domMonitor.start();
		}
	} else {
		log(
			'CDP: No webview targets found yet. This is normal if no agent panel is open.\n' +
				`  Ensure your IDE is launched with: --remote-debugging-port=${port}\n` +
				'\n' +
				`  macOS:   open -a "Antigravity" --args --remote-debugging-port=${port}\n` +
				`  Linux:   antigravity --remote-debugging-port=${port}\n` +
				`  Windows: Add --remote-debugging-port=${port} to shortcut target\n` +
				'\n' +
				'  The extension will keep polling for new targets every 10s.'
		);

		// Check if CDP port is reachable at all
		const http = await import('http');
		const portCheck = new Promise<boolean>((resolve) => {
			const req = http.get(`http://127.0.0.1:${port}/json/version`, { timeout: 2000 }, () => {
				resolve(true);
			});
			req.on('error', () => resolve(false));
			req.on('timeout', () => {
				req.destroy();
				resolve(false);
			});
		});

		const portReachable = await portCheck;
		if (portReachable) {
			// Port is open but no webview targets — just wait, they'll appear
			updateStatusBar('connecting');
			log('CDP: Port is reachable but no webview targets yet. Waiting for agent panel...');
			if (enabled) {
				domMonitor.start();
			}
		} else {
			// Port is not open — user needs to restart IDE
			updateStatusBar('error');
			vscode.window
				.showWarningMessage(
					`AI Auto Agent: Cannot reach CDP port ${port}. ` +
						`Please restart your IDE with: open -a "Antigravity" --args --remote-debugging-port=${port}`,
					'Show Setup Guide'
				)
				.then((selection) => {
					if (selection === 'Show Setup Guide') {
						outputChannel.show();
					}
				});
		}
	}
}

function updateStatusBar(
	state: 'connecting' | 'active' | 'disabled' | 'retrying' | 'error',
	detail?: string
): void {
	switch (state) {
		case 'connecting':
			statusBarItem.text = '$(sync~spin) AAA';
			statusBarItem.tooltip = 'AI Auto Agent: Connecting to CDP...';
			statusBarItem.color = '#fbbf24';
			break;
		case 'active':
			statusBarItem.text = '$(zap) AAA';
			statusBarItem.tooltip = `AI Auto Agent: Active${detail ? ' — ' + detail : ''}`;
			statusBarItem.color = '#4ade80';
			break;
		case 'disabled':
			statusBarItem.text = '$(circle-slash) AAA';
			statusBarItem.tooltip = 'AI Auto Agent: Disabled (Cmd+Shift+A to toggle)';
			statusBarItem.color = '#9ca3af';
			break;
		case 'retrying':
			statusBarItem.text = '$(sync~spin) AAA';
			statusBarItem.tooltip = `AI Auto Agent: ${detail || 'Retrying...'}`;
			statusBarItem.color = '#f97316';
			break;
		case 'error':
			statusBarItem.text = '$(warning) AAA';
			statusBarItem.tooltip = 'AI Auto Agent: CDP not connected. Click to toggle.';
			statusBarItem.color = '#ef4444';
			break;
	}
}

export function deactivate() {
	domMonitor?.stop();
	cdpClient?.disconnect();
}

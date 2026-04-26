import * as vscode from 'vscode';
import { CDPClient } from '../cdp/cdpClient';
import { DOMMonitor, DetectedElement } from '../cdp/domMonitor';

/**
 * ModelRotation — Automatically switches to the next model when quota is exhausted.
 *
 * When the DOMMonitor detects a "quota exceeded" error:
 * 1. Determines the next model in the rotation list
 * 2. Attempts to switch via VS Code configuration or CDP DOM manipulation
 * 3. Resets the retry counter
 */
export class ModelRotation implements vscode.Disposable {
	private monitor: DOMMonitor;
	private cdp: CDPClient;
	private log: (msg: string) => void;
	private enabled = true;
	private modelList: string[];
	private currentIndex = 0;

	/** Index at which the current rotation cycle started. */
	private cycleStartIndex = -1;
	/** Whether a rotation cycle is currently in progress. */
	private cycleActive = false;

	/** Cooldown: don't switch models more often than this. */
	private lastSwitchTime = 0;
	private static readonly SWITCH_COOLDOWN_MS = 10_000;

	/** Total model switches since activation. */
	totalSwitches = 0;

	private _onSwitch = new vscode.EventEmitter<{ from: string; to: string }>();
	readonly onSwitch = this._onSwitch.event;

	constructor(
		monitor: DOMMonitor,
		cdp: CDPClient,
		log: (msg: string) => void,
		modelList: string[]
	) {
		this.monitor = monitor;
		this.cdp = cdp;
		this.log = log;
		this.modelList = modelList;

		this.monitor.onDetect((el) => this.handleElement(el));
	}

	setEnabled(enabled: boolean): void {
		this.enabled = enabled;
	}

	updateModelList(models: string[]): void {
		this.modelList = models;
		// Reset index if it's out of bounds
		if (this.currentIndex >= this.modelList.length) {
			this.currentIndex = 0;
		}
	}

	/**
	 * Get the current model name.
	 */
	getCurrentModel(): string {
		return this.modelList[this.currentIndex] || 'unknown';
	}

	/**
	 * Get the next model in the rotation.
	 */
	getNextModel(): string {
		const nextIndex = (this.currentIndex + 1) % this.modelList.length;
		return this.modelList[nextIndex] || 'unknown';
	}

	/**
	 * Check if we've completed a full cycle through all models.
	 * Returns true when the rotation has gone through every model
	 * and would cycle back to the starting model.
	 */
	hasCompletedCycle(): boolean {
		if (!this.cycleActive || this.modelList.length <= 1) {
			return false;
		}
		// The next model would be the one we started with
		const nextIndex = (this.currentIndex + 1) % this.modelList.length;
		return nextIndex === this.cycleStartIndex;
	}

	/**
	 * Reset the rotation cycle tracker.
	 * Call this when the user manually intervenes (e.g., manual retry or model switch).
	 */
	resetCycle(): void {
		this.cycleActive = false;
		this.cycleStartIndex = -1;
		this.log('ModelRotation: Cycle tracker reset');
	}

	/**
	 * Manually trigger a model switch.
	 */
	async switchToNext(): Promise<boolean> {
		if (this.modelList.length <= 1) {
			this.log('ModelRotation: Only one model configured, cannot switch');
			return false;
		}

		// Start cycle tracking if not already active
		if (!this.cycleActive) {
			this.cycleStartIndex = this.currentIndex;
			this.cycleActive = true;
			this.log(`ModelRotation: Starting rotation cycle from index ${this.currentIndex}`);
		}

		const from = this.getCurrentModel();
		this.currentIndex = (this.currentIndex + 1) % this.modelList.length;
		const to = this.getCurrentModel();

		this.log(`ModelRotation: Switching from ${from} to ${to}`);
		this.totalSwitches++;
		this.lastSwitchTime = Date.now();

		// Strategy 1: Try to update VS Code configuration
		// Different IDEs use different config keys — try common ones
		const configKeys = [
			'antigravity.model',
			'antigravity.defaultModel',
			'chat.model',
			'ai.model',
		];

		let switched = false;
		for (const key of configKeys) {
			try {
				const [prefix, suffix] = key.split('.');
				const config = vscode.workspace.getConfiguration(prefix);
				const inspected = config.inspect(suffix!);
				if (inspected !== undefined) {
					await config.update(suffix!, to, vscode.ConfigurationTarget.Global);
					this.log(`ModelRotation: Updated ${key} = ${to}`);
					switched = true;
					break;
				}
			} catch {
				// Config key doesn't exist, try next
			}
		}

		// Strategy 2: Try CDP-based model selector click (broadcast to all sessions)
		if (!switched) {
			this.log('ModelRotation: No matching config key found, trying CDP model selector');
			try {
				await this.switchViaDOM(to);
				switched = true;
			} catch (err) {
				this.log(`ModelRotation: CDP switch failed: ${err}`);
			}
		}

		if (switched) {
			this._onSwitch.fire({ from, to });
			vscode.window.showInformationMessage(
				`🔄 AI Auto Agent: Switched model from ${from} to ${to}`
			);
		} else {
			this.log(`ModelRotation: Failed to switch model to ${to}`);
			vscode.window.showWarningMessage(
				`⚠️ AI Auto Agent: Could not switch to ${to} automatically. ` +
					`Please switch manually in your IDE settings.`
			);
		}

		return switched;
	}

	/** Common CSS selectors for model dropdown elements across IDEs. */
	private static readonly MODEL_SELECTOR_QUERIES = [
		// Antigravity / VS Code agent panel selectors
		'[class*="model-selector"]',
		'[class*="modelSelector"]',
		'[class*="model-picker"]',
		'[class*="modelPicker"]',
		'[class*="model-dropdown"]',
		'[class*="modelDropdown"]',
		'[class*="model-select"]',
		'[class*="modelSelect"]',
		// Data attributes
		'[data-testid*="model"]',
		'[data-action*="model"]',
		// ARIA roles — combobox/listbox patterns
		'[role="combobox"][aria-label*="model" i]',
		'[role="combobox"][aria-label*="Model" i]',
		'[role="listbox"][aria-label*="model" i]',
		// Select elements
		'select[class*="model"]',
		'select[name*="model"]',
		'select[id*="model"]',
		// Dropdown triggers near the chat input
		'[class*="chat-model"]',
		'[class*="agent-model"]',
		// Button-style dropdowns that contain model names
		'button[class*="model"]',
		'button[aria-label*="model" i]',
		'button[aria-label*="Model" i]',
		// Generic dropdown within agent / chat containers
		'[class*="agent-panel"] [class*="dropdown"]',
		'[class*="chat-panel"] [class*="dropdown"]',
		'[class*="agent"] select',
		'[class*="chat"] select',
	];

	/** CSS selectors for dropdown option items. */
	private static readonly OPTION_SELECTORS =
		'[class*="option"], [class*="item"], [role="option"], ' +
		'[role="menuitem"], [role="menuitemradio"], ' +
		'[class*="dropdown-item"], [class*="list-item"], ' +
		'[class*="select-item"], li';

	/**
	 * Try to switch model via DOM manipulation in all active sessions.
	 */
	private async switchViaDOM(targetModel: string): Promise<void> {
		const selectors = JSON.stringify(ModelRotation.MODEL_SELECTOR_QUERIES);
		const optionSelectors = ModelRotation.OPTION_SELECTORS;
		const target = targetModel.toLowerCase();
		const script = `
			(function() {
				var selectors = ${selectors};
				for (var i = 0; i < selectors.length; i++) {
					var el = document.querySelector(selectors[i]);
					if (el) {
						el.click();
						return new Promise(function(resolve) {
							setTimeout(function() {
								var options = document.querySelectorAll('${optionSelectors}');
								for (var j = 0; j < options.length; j++) {
									if ((options[j].textContent || '').toLowerCase().includes('${target}')) {
										options[j].click();
										resolve(true);
										return;
									}
								}
								// Close dropdown
								el.click();
								document.body.click();
								resolve(false);
							}, 500);
						});
					}
				}
				return false;
			})()
		`;

		const results = await this.cdp.evaluateAll(script);

		// Check if any session succeeded
		let anySuccess = false;
		for (const val of results.values()) {
			if (val === true) {
				anySuccess = true;
				break;
			}
		}

		if (!anySuccess) {
			throw new Error('Model selector not found in any session');
		}
	}

	/**
	 * Fetch available models dynamically via CDP.
	 */
	/**
	 * Known model name patterns to validate fetched items are actually models.
	 * This prevents commands, menu items, and other non-model text from appearing.
	 */
	private static readonly MODEL_NAME_PATTERNS = [
		/claude/i,
		/gpt/i,
		/gemini/i,
		/llama/i,
		/mistral/i,
		/opus/i,
		/sonnet/i,
		/haiku/i,
		/o[1-9]/i, // o1, o3, o4 etc.
		/deepseek/i,
		/qwen/i,
		/codestral/i,
		/command[- ]?r/i,
		/phi[- ]?[0-9]/i,
		/flash/i, // Gemini Flash
		/pro/i, // Gemini Pro
		/thinking/i,
	];

	/**
	 * Check if a text string looks like a model name.
	 */
	private static looksLikeModelName(text: string): boolean {
		// Must not be too long (commands tend to be long phrases)
		if (text.length > 80) return false;
		// Must not contain common command/action words
		const commandPatterns =
			/^(select|open|run|show|debug|toggle|enable|disable|configure|settings|search|help|view|edit|copy|paste|delete|new |save|close|file|terminal|git )/i;
		if (commandPatterns.test(text)) return false;
		// Check if it matches any known model pattern
		return ModelRotation.MODEL_NAME_PATTERNS.some((p) => p.test(text));
	}

	async fetchAvailableModels(): Promise<string[]> {
		const selectors = JSON.stringify(ModelRotation.MODEL_SELECTOR_QUERIES);
		const optionSelectors = ModelRotation.OPTION_SELECTORS;
		const script = `
			(function() {
				var selectors = ${selectors};
				var selectorEl = null;
				var matchedSelector = '';
				for (var i = 0; i < selectors.length; i++) {
					var el = document.querySelector(selectors[i]);
					if (el) {
						selectorEl = el;
						matchedSelector = selectors[i];
						break;
					}
				}
				if (!selectorEl) return { models: [], matchedSelector: '', debug: 'No model selector found. Tried ' + selectors.length + ' selectors.' };

				// Click to open dropdown so options render
				selectorEl.click();
				
				return new Promise(function(resolve) {
					setTimeout(function() {
						var options = document.querySelectorAll('${optionSelectors}');
						var rawTexts = [];
						for (var j = 0; j < options.length; j++) {
							var text = (options[j].textContent || '').trim();
							if (text && text.length > 2 && text.length < 100) {
								rawTexts.push(text);
							}
						}
						// Close the dropdown
						selectorEl.click();
						document.body.click(); 
						resolve({
							models: rawTexts,
							matchedSelector: matchedSelector,
							debug: 'Matched: ' + matchedSelector + ', raw options: ' + rawTexts.length +
								', texts: [' + rawTexts.slice(0, 10).join(', ') + ']'
						});
					}, 300);
				});
			})()
		`;

		this.log('ModelRotation: Fetching available models via CDP...');
		const results = await this.cdp.evaluateAll(script);

		// Map and flatten all results, then filter unique
		const allRawTexts = new Set<string>();
		for (const [targetId, val] of results.entries()) {
			if (val && typeof val === 'object') {
				const obj = val as { models?: string[]; matchedSelector?: string; debug?: string };
				if (obj.debug) {
					this.log(`ModelRotation: [${targetId.substring(0, 8)}] ${obj.debug}`);
				}
				if (Array.isArray(obj.models)) {
					for (const text of obj.models) {
						allRawTexts.add(text);
					}
				}
			} else if (Array.isArray(val)) {
				for (const text of val) {
					allRawTexts.add(text);
				}
			}
		}

		// Filter: only keep entries that look like actual model names
		const validModels = Array.from(allRawTexts).filter((text) =>
			ModelRotation.looksLikeModelName(text)
		);

		if (validModels.length === 0 && allRawTexts.size > 0) {
			// We found items but none look like models — log them for debugging
			this.log(
				`ModelRotation: ⚠️ Found ${allRawTexts.size} dropdown items but NONE look like model names. ` +
					`Items: ${Array.from(allRawTexts).slice(0, 10).join(' | ')}. ` +
					`The matched selector is likely NOT the model dropdown. ` +
					`Run "Debug Model Selector DOM" command for details.`
			);
		}

		this.log(`ModelRotation: Found ${validModels.length} model(s): ${validModels.join(', ')}`);
		return validModels;
	}

	/**
	 * Dump the DOM structure around potential model selectors for debugging.
	 * Returns HTML snippets to help identify the correct CSS selectors.
	 */
	async dumpModelSelectorDOM(): Promise<string> {
		const selectors = JSON.stringify(ModelRotation.MODEL_SELECTOR_QUERIES);
		const script = `
			(function() {
				var selectors = ${selectors};
				var report = [];
				
				// Check each selector
				for (var i = 0; i < selectors.length; i++) {
					var els = document.querySelectorAll(selectors[i]);
					if (els.length > 0) {
						report.push('✓ ' + selectors[i] + ' → ' + els.length + ' match(es)');
						for (var j = 0; j < Math.min(els.length, 3); j++) {
							report.push('  tag=' + els[j].tagName + ' class="' + (els[j].className || '') + '" text="' + (els[j].textContent || '').trim().substring(0, 80) + '"');
						}
					}
				}
				
				if (report.length === 0) {
					report.push('✗ No known model selectors found.');
					// Dump clickable elements that might be model-related
					report.push('');
					report.push('Potential candidates (elements with "model" in class/text/aria):');
					var all = document.querySelectorAll('*');
					var candidates = 0;
					for (var k = 0; k < all.length && candidates < 20; k++) {
						var el = all[k];
						var cls = (el.className && typeof el.className === 'string') ? el.className : '';
						var aria = el.getAttribute('aria-label') || '';
						var text = (el.textContent || '').trim().substring(0, 60);
						var combined = (cls + ' ' + aria + ' ' + text).toLowerCase();
						if (combined.indexOf('model') !== -1 || combined.indexOf('dropdown') !== -1 || combined.indexOf('selector') !== -1) {
							var rect = el.getBoundingClientRect();
							if (rect.width > 0 && rect.height > 0) {
								report.push('  <' + el.tagName.toLowerCase() + ' class="' + cls.substring(0, 80) + '" aria-label="' + aria + '"> text="' + text.substring(0, 50) + '" [' + Math.round(rect.width) + 'x' + Math.round(rect.height) + ']');
								candidates++;
							}
						}
					}
					if (candidates === 0) {
						report.push('  (none found — the model selector may not be rendered yet)');
					}
				}
				
				return report.join('\\n');
			})()
		`;

		const results = await this.cdp.evaluateAll(script);

		const reports: string[] = [];
		for (const [targetId, val] of results.entries()) {
			if (typeof val === 'string') {
				reports.push(`── Session ${targetId.substring(0, 8)} ──\n${val}`);
			}
		}

		return reports.join('\n\n') || 'No CDP sessions available.';
	}

	/**
	 * Handle detected DOM elements.
	 */
	private async handleElement(el: DetectedElement): Promise<void> {
		if (!this.enabled) {
			return;
		}
		// Only switch models for actual quota exhaustion
		// Rate limits, server errors, etc. should be handled by AutoRetry (wait + retry)
		if (el.type !== 'error-classified' || el.errorCategory !== 'quota-exhausted') {
			return;
		}

		// Cooldown check
		const now = Date.now();
		if (now - this.lastSwitchTime < ModelRotation.SWITCH_COOLDOWN_MS) {
			return;
		}

		this.log(`ModelRotation: Quota exhausted detected: "${el.text.substring(0, 100)}"`);
		await this.switchToNext();
	}

	dispose(): void {
		this._onSwitch.dispose();
	}
}

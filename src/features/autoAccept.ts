import * as vscode from 'vscode';
import { DOMMonitor, DetectedElement } from '../cdp/domMonitor';

/**
 * AutoAccept — Automatically accepts file edits, terminal commands, and permissions.
 *
 * In the new architecture, buttons are clicked IN-PAGE by the MutationObserver.
 * This module receives detection events and handles:
 * - Statistics tracking (total accepts, total blocked)
 * - Event emission for UI feedback
 * - Dangerous command blocking notifications
 *
 * Safety rules:
 * - File edits: auto-accepted (can be reverted via git)
 * - Terminal commands: checked against a dangerous command blocklist in-page
 * - Permissions (Allow/Always Allow): auto-accepted
 */
export class AutoAccept implements vscode.Disposable {
	private monitor: DOMMonitor;
	private log: (msg: string) => void;
	private enabled = false;
	private dangerousCommands: string[];

	/** Total auto-accepts since activation. */
	totalAccepts = 0;
	/** Total blocked dangerous commands. */
	totalBlocked = 0;

	private _onAccept = new vscode.EventEmitter<{ type: string; detail: string }>();
	readonly onAccept = this._onAccept.event;

	private _onBlock = new vscode.EventEmitter<{ command: string; reason: string }>();
	readonly onBlock = this._onBlock.event;

	constructor(monitor: DOMMonitor, log: (msg: string) => void, dangerousCommands: string[]) {
		this.monitor = monitor;
		this.log = log;
		this.dangerousCommands = dangerousCommands;

		// Push dangerous commands to the monitor for in-page filtering
		this.monitor.updateDangerousCommands(dangerousCommands);

		this.monitor.onDetect((el) => this.handleElement(el));
	}

	setEnabled(enabled: boolean): void {
		this.enabled = enabled;
	}

	updateDangerousCommands(commands: string[]): void {
		this.dangerousCommands = commands;
		// Update the in-page observer with the new list
		this.monitor.updateDangerousCommands(commands);
	}

	/**
	 * Handle a detected DOM element.
	 * Note: In the new architecture, buttons are already clicked by the
	 * in-page MutationObserver. This handler tracks statistics and emits events.
	 */
	private async handleElement(el: DetectedElement): Promise<void> {
		if (!this.enabled) {
			return;
		}

		switch (el.type) {
			case 'accept-edit':
				this.totalAccepts++;
				this.log('AutoAccept: ✓ File edit accepted');
				this._onAccept.fire({ type: 'edit', detail: 'file edit' });
				break;

			case 'run-command':
			case 'accept-command':
				this.totalAccepts++;
				this.log(`AutoAccept: ✓ Command accepted: ${el.commandText}`);
				this._onAccept.fire({ type: 'command', detail: el.commandText });
				break;

			case 'allow-permission':
				this.totalAccepts++;
				this.log('AutoAccept: ✓ Permission allowed');
				this._onAccept.fire({ type: 'permission', detail: 'allow' });
				break;
		}
	}

	dispose(): void {
		this._onAccept.dispose();
		this._onBlock.dispose();
	}
}

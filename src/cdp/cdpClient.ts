import * as vscode from 'vscode';
import WebSocket from 'ws';
import * as http from 'http';

/**
 * CDP Target info returned by the /json endpoint.
 */
export interface CDPTarget {
	id: string;
	title: string;
	type: string;
	url: string;
	webSocketDebuggerUrl: string;
}

/**
 * A single CDP session — one WebSocket to one webview target.
 */
export interface CDPSession {
	targetId: string;
	wsUrl: string;
	ws: WebSocket;
	messageId: number;
	pendingCallbacks: Map<
		number,
		{
			resolve: (value: unknown) => void;
			reject: (reason: unknown) => void;
		}
	>;
	/** Number of consecutive heartbeat failures. */
	failCount: number;
	/** Whether the MutationObserver is confirmed alive. */
	observerAlive: boolean;
	/** Whether this is the main workbench window (not a webview iframe). */
	isMainWindow?: boolean;
}

/**
 * Callback for data received from injected page scripts via Runtime.addBinding.
 */
export type BindingCallback = (payload: string, session: CDPSession) => void;

/**
 * CDPClient — Multi-session manager for Chrome DevTools Protocol.
 *
 * Connects to Antigravity's Electron process via `--remote-debugging-port`
 * and manages **multiple WebSocket sessions** — one per `vscode-webview://`
 * target where the agent panel lives.
 *
 * Architecture:
 * - Target discovery via `/json` HTTP endpoint (polls every 10s)
 * - Only attaches to `vscode-webview://` targets (whitelist filter)
 * - Each session gets its own WebSocket + message ID counter
 * - Heartbeat (10s) validates session health and prunes dead ones
 * - Binding callback mechanism for MutationObserver → Node.js IPC
 */
export class CDPClient implements vscode.Disposable {
	private port: number;
	private log: (msg: string) => void;

	/** Active sessions keyed by target ID. */
	readonly sessions = new Map<string, CDPSession>();

	/** The main workbench window session (for dialog detection). */
	mainWindowSession: CDPSession | undefined;

	/** Targets we've tried and decided to ignore (not agent panel). */
	private ignoredTargets = new Set<string>();

	/** Timer for periodic target discovery + heartbeat. */
	private discoveryTimer: NodeJS.Timeout | undefined;

	/** Binding callbacks: name → handler */
	private bindingCallbacks = new Map<string, BindingCallback>();

	/** Status change callback */
	onStatusChange?: () => void;

	/** Discovery + heartbeat interval. */
	private static readonly HEARTBEAT_INTERVAL_MS = 10_000;
	/** Max consecutive heartbeat failures before pruning a session. */
	private static readonly MAX_FAIL_COUNT = 3;

	constructor(port: number, log: (msg: string) => void) {
		this.port = port;
		this.log = log;
	}

	/**
	 * Whether at least one CDP session is active.
	 */
	isConnected(): boolean {
		return this.sessions.size > 0;
	}

	/**
	 * Get the number of active sessions.
	 */
	get sessionCount(): number {
		return this.sessions.size;
	}

	/**
	 * Register a binding callback. When injected page scripts call
	 * the binding function, this callback fires on the Node.js side.
	 */
	addBinding(name: string, callback: BindingCallback): void {
		this.bindingCallbacks.set(name, callback);
	}

	/**
	 * Start target discovery and heartbeat loop.
	 * Returns true if at least one webview session was established.
	 */
	async connect(): Promise<boolean> {
		// Do an initial discovery pass
		const attached = await this.discoverAndAttach();

		// Start periodic discovery + heartbeat
		if (!this.discoveryTimer) {
			this.discoveryTimer = setInterval(async () => {
				try {
					await this.discoverAndAttach();
					await this.heartbeat();
				} catch {
					// Swallow errors — will retry next cycle
				}
			}, CDPClient.HEARTBEAT_INTERVAL_MS);
		}

		return attached > 0;
	}

	/**
	 * Discover CDP targets and attach to new webview targets.
	 * Returns the number of newly attached sessions.
	 */
	private async discoverAndAttach(): Promise<number> {
		let targets: CDPTarget[];
		try {
			targets = await this.fetchTargets();
		} catch (err) {
			// CDP port not reachable — no action
			return 0;
		}

		// Filter to vscode-webview:// and Antigravity agent panel targets
		const webviewTargets = targets.filter(
			(t) =>
				(t.url.startsWith('vscode-webview://') ||
					t.url.includes('workbench-jetski-agent.html')) &&
				t.webSocketDebuggerUrl &&
				!this.sessions.has(t.id) &&
				!this.ignoredTargets.has(t.id)
		);

		let attached = 0;
		for (const target of webviewTargets) {
			try {
				await this.attachToTarget(target);
				attached++;
			} catch (err) {
				this.log(`CDP: Failed to attach to ${target.id.substring(0, 8)}: ${err}`);
			}
		}

		// Attach to the main workbench window for dialog detection
		if (!this.mainWindowSession) {
			const mainTarget = targets.find(
				(t) =>
					t.type === 'page' &&
					(t.url.includes('workbench.html') ||
						t.url.includes('workbench-desktop.html')) &&
					t.webSocketDebuggerUrl &&
					!this.sessions.has(t.id)
			);
			if (mainTarget) {
				try {
					await this.attachToTarget(mainTarget);
					const session = this.sessions.get(mainTarget.id);
					if (session) {
						session.isMainWindow = true;
						this.mainWindowSession = session;
						this.log(
							`CDP: ✓ Main workbench window attached (${mainTarget.id.substring(0, 8)})`
						);
					}
				} catch (err) {
					this.log(`CDP: Failed to attach to main window: ${err}`);
				}
			}
		} else if (this.mainWindowSession.ws.readyState !== WebSocket.OPEN) {
			// Main window session died — clean up
			this.mainWindowSession = undefined;
		}

		// Prune sessions whose targets no longer exist
		const activeTargetIds = new Set(targets.map((t) => t.id));
		for (const [targetId, session] of this.sessions) {
			if (!activeTargetIds.has(targetId)) {
				this.log(`CDP: Target ${targetId.substring(0, 8)} disappeared — detaching`);
				if (session.isMainWindow) {
					this.mainWindowSession = undefined;
				}
				this.detachSession(session);
			}
		}

		if (attached > 0) {
			this.log(
				`CDP: Attached to ${attached} new webview target(s). Total sessions: ${this.sessions.size}`
			);
			this.onStatusChange?.();
		}

		return attached;
	}

	/**
	 * Fetch CDP targets from the /json HTTP endpoint.
	 */
	private fetchTargets(): Promise<CDPTarget[]> {
		return new Promise((resolve, reject) => {
			const req = http.get(
				`http://127.0.0.1:${this.port}/json`,
				{ timeout: 3000 },
				(res: http.IncomingMessage) => {
					let data = '';
					res.on('data', (chunk: Buffer) => {
						data += chunk;
					});
					res.on('end', () => {
						try {
							resolve(JSON.parse(data) as CDPTarget[]);
						} catch (e) {
							reject(new Error(`Failed to parse targets: ${e}`));
						}
					});
				}
			);
			req.on('error', (e: Error) => reject(e));
			req.on('timeout', () => {
				req.destroy();
				reject(new Error('timeout'));
			});
		});
	}

	/**
	 * Establish a WebSocket session to a specific target.
	 */
	private attachToTarget(target: CDPTarget): Promise<void> {
		return new Promise((resolve, reject) => {
			const ws = new WebSocket(target.webSocketDebuggerUrl);

			const session: CDPSession = {
				targetId: target.id,
				wsUrl: target.webSocketDebuggerUrl,
				ws,
				messageId: 0,
				pendingCallbacks: new Map(),
				failCount: 0,
				observerAlive: false,
			};

			const connectTimeout = setTimeout(() => {
				ws.terminate();
				reject(new Error('Connection timeout'));
			}, 5000);

			ws.on('open', async () => {
				clearTimeout(connectTimeout);
				this.sessions.set(target.id, session);
				this.log(
					`CDP: ✓ Session ${target.id.substring(0, 8)} connected (${target.url.substring(0, 60)})`
				);

				// Enable Runtime.addBinding for IPC from injected scripts
				try {
					for (const bindingName of this.bindingCallbacks.keys()) {
						await this.sendToSession(session, 'Runtime.addBinding', {
							name: bindingName,
						});
					}
					// Listen for binding calls
					await this.sendToSession(session, 'Runtime.enable', {});
				} catch (err) {
					this.log(
						`CDP: Warning — could not set up bindings for ${target.id.substring(0, 8)}: ${err}`
					);
				}

				resolve();
			});

			ws.on('message', (data: WebSocket.Data) => {
				try {
					const msg = JSON.parse(data.toString()) as {
						id?: number;
						result?: unknown;
						error?: { message: string };
						method?: string;
						params?: Record<string, unknown>;
					};

					// Response to a request
					if (msg.id !== undefined) {
						const cb = session.pendingCallbacks.get(msg.id);
						if (cb) {
							session.pendingCallbacks.delete(msg.id);
							if (msg.error) {
								cb.reject(new Error(msg.error.message));
							} else {
								cb.resolve(msg.result);
							}
						}
					}

					// Binding call from injected script
					if (msg.method === 'Runtime.bindingCalled' && msg.params) {
						const name = msg.params['name'] as string;
						const payload = msg.params['payload'] as string;
						const handler = this.bindingCallbacks.get(name);
						if (handler) {
							try {
								handler(payload, session);
							} catch (err) {
								this.log(`CDP: Binding handler error for "${name}": ${err}`);
							}
						}
					}
				} catch {
					// Ignore malformed messages
				}
			});

			ws.on('close', () => {
				this.log(`CDP: Session ${target.id.substring(0, 8)} disconnected`);
				this.sessions.delete(target.id);
				this.onStatusChange?.();
			});

			ws.on('error', (err: Error) => {
				if (!this.sessions.has(target.id)) {
					clearTimeout(connectTimeout);
					reject(err);
				}
			});
		});
	}

	/**
	 * Heartbeat — validate existing sessions, re-inject dead observers.
	 */
	private async heartbeat(): Promise<void> {
		for (const [targetId, session] of this.sessions) {
			if (session.ws.readyState !== WebSocket.OPEN) {
				session.failCount++;
				if (session.failCount >= CDPClient.MAX_FAIL_COUNT) {
					this.log(
						`CDP: Pruning dead session ${targetId.substring(0, 8)} (${session.failCount} failures)`
					);
					this.detachSession(session);
				}
				continue;
			}

			// Ping the session to check liveness
			try {
				const result = (await this.evalInSession(session, '1+1')) as number;
				if (result === 2) {
					session.failCount = 0;
				} else {
					session.failCount++;
				}
			} catch {
				session.failCount++;
				if (session.failCount >= CDPClient.MAX_FAIL_COUNT) {
					this.log(`CDP: Pruning unreachable session ${targetId.substring(0, 8)}`);
					this.detachSession(session);
				}
			}
		}
	}

	/**
	 * Send a CDP command to a specific session.
	 */
	sendToSession(
		session: CDPSession,
		method: string,
		params?: Record<string, unknown>
	): Promise<unknown> {
		if (session.ws.readyState !== WebSocket.OPEN) {
			return Promise.reject(new Error('Session not connected'));
		}

		const id = ++session.messageId;
		const message = JSON.stringify({ id, method, params: params || {} });

		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				session.pendingCallbacks.delete(id);
				reject(new Error(`Timeout: ${method}`));
			}, 10000);

			session.pendingCallbacks.set(id, {
				resolve: (val) => {
					clearTimeout(timeout);
					resolve(val);
				},
				reject: (err) => {
					clearTimeout(timeout);
					reject(err);
				},
			});

			session.ws.send(message, (err) => {
				if (err) {
					clearTimeout(timeout);
					session.pendingCallbacks.delete(id);
					reject(err);
				}
			});
		});
	}

	/**
	 * Evaluate a JavaScript expression in a specific session.
	 */
	async evalInSession(session: CDPSession, expression: string): Promise<unknown> {
		const result = (await this.sendToSession(session, 'Runtime.evaluate', {
			expression,
			returnByValue: true,
			awaitPromise: true,
		})) as { result?: { value?: unknown }; exceptionDetails?: { text: string } };

		if (result.exceptionDetails) {
			throw new Error(`CDP eval error: ${result.exceptionDetails.text}`);
		}

		return result.result?.value;
	}

	/**
	 * Evaluate a JavaScript expression in ALL active sessions.
	 * Returns results keyed by targetId.
	 */
	async evaluateAll(expression: string): Promise<Map<string, unknown>> {
		const results = new Map<string, unknown>();
		const promises: Promise<void>[] = [];

		for (const [targetId, session] of this.sessions) {
			promises.push(
				this.evalInSession(session, expression)
					.then((val) => {
						results.set(targetId, val);
					})
					.catch(() => {
						/* skip failed sessions */
					})
			);
		}

		await Promise.allSettled(promises);
		return results;
	}

	/**
	 * Detach and clean up a session.
	 */
	private detachSession(session: CDPSession): void {
		try {
			session.ws.close();
		} catch {
			/* ignore */
		}
		session.pendingCallbacks.clear();
		this.sessions.delete(session.targetId);
		this.onStatusChange?.();
	}

	/**
	 * Mark a target as ignored (not an agent panel).
	 */
	ignoreTarget(targetId: string): void {
		this.ignoredTargets.add(targetId);
	}

	/**
	 * Disconnect all sessions and stop discovery.
	 */
	disconnect(): void {
		if (this.discoveryTimer) {
			clearInterval(this.discoveryTimer);
			this.discoveryTimer = undefined;
		}
		for (const session of this.sessions.values()) {
			try {
				session.ws.close();
			} catch {
				/* ignore */
			}
			session.pendingCallbacks.clear();
		}
		this.sessions.clear();
		this.ignoredTargets.clear();
		this.bindingCallbacks.clear();
	}

	dispose(): void {
		this.disconnect();
	}
}

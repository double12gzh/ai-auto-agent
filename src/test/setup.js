/* eslint-disable */
// mock vscode
const sinon = require('sinon');

class MockEventEmitter {
	constructor() {
		this._listeners = [];
		this.event = (listener) => {
			this._listeners.push(listener);
			return { dispose: () => {
				const idx = this._listeners.indexOf(listener);
				if (idx >= 0) this._listeners.splice(idx, 1);
			}};
		};
		this.fire = (data) => {
			for (const listener of this._listeners) {
				listener(data);
			}
		};
		this.dispose = sinon.spy();
	}
}


class MockDisposable {
	static from(...args) {
		return { dispose: sinon.spy() };
	}
}

const vscode = {
	EventEmitter: MockEventEmitter,
	Disposable: MockDisposable,
	workspace: {
		getConfiguration: sinon.stub().returns({ get: sinon.spy() }),
		onDidChangeConfiguration: sinon.stub(),
	},
	window: {
		createOutputChannel: sinon.stub(),
		createStatusBarItem: sinon.stub(),
		showWarningMessage: sinon.stub(),
	},
};

const Module = require('module');
const originalRequire = Module.prototype.require;

Module.prototype.require = function () {
	if (arguments[0] === 'vscode') {
		return vscode;
	}
	return originalRequire.apply(this, arguments);
};

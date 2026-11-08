/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Voidly. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import { exec } from 'child_process';
// 注意：不要把 `ClipboardItem` 放进命名导入——Electron 34（当前安装版本）没有这个导出，
// ESM 命名导入会在模块加载时直接抛 SyntaxError，拖垮整个 nativeHostMainService 的加载。
// 44 才有的 API 一律走 `electron` 命名空间动态访问（见下方 Clipboard 区域的运行时探测）。
import { app, BrowserWindow, clipboard, Display, Menu, MessageBoxOptions, MessageBoxReturnValue, nativeImage, OpenDevToolsOptions, OpenDialogOptions, OpenDialogReturnValue, powerMonitor, SaveDialogOptions, SaveDialogReturnValue, screen, shell, webContents } from 'electron';
import * as electron from 'electron';
import { arch, cpus, freemem, loadavg, platform, release, totalmem, type } from 'os';
import { promisify } from 'util';
import { memoize } from '../../../base/common/decorators.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { matchesSomeScheme, Schemas } from '../../../base/common/network.js';
import { dirname, join, posix, resolve, win32 } from '../../../base/common/path.js';
import { isLinux, isMacintosh, isWindows } from '../../../base/common/platform.js';
import { AddFirstParameterToFunctions } from '../../../base/common/types.js';
import { URI } from '../../../base/common/uri.js';
import { realpath } from '../../../base/node/extpath.js';
import { virtualMachineHint } from '../../../base/node/id.js';
import { Promises, SymlinkSupport } from '../../../base/node/pfs.js';
import { findFreePort } from '../../../base/node/ports.js';
import { localize } from '../../../nls.js';
import { ISerializableCommandAction } from '../../action/common/action.js';
import { INativeOpenDialogOptions } from '../../dialogs/common/dialogs.js';
import { IDialogMainService } from '../../dialogs/electron-main/dialogMainService.js';
import { IEnvironmentMainService } from '../../environment/electron-main/environmentMainService.js';
import { createDecorator, IInstantiationService } from '../../instantiation/common/instantiation.js';
import { ILifecycleMainService, IRelaunchOptions } from '../../lifecycle/electron-main/lifecycleMainService.js';
import { ILogService } from '../../log/common/log.js';
import { ICommonNativeHostService, INativeHostOptions, IOSProperties, IOSStatistics } from '../common/native.js';
import { IProductService } from '../../product/common/productService.js';
import { IPartsSplash } from '../../theme/common/themeService.js';
import { IThemeMainService } from '../../theme/electron-main/themeMainService.js';
import { defaultWindowState, ICodeWindow } from '../../window/electron-main/window.js';
import { IColorScheme, IOpenedAuxiliaryWindow, IOpenedMainWindow, IOpenEmptyWindowOptions, IOpenWindowOptions, IPoint, IRectangle, IWindowOpenable } from '../../window/common/window.js';
import { defaultBrowserWindowOptions, IWindowsMainService, OpenContext } from '../../windows/electron-main/windows.js';
import { isWorkspaceIdentifier, toWorkspaceIdentifier } from '../../workspace/common/workspace.js';
import { IWorkspacesManagementMainService } from '../../workspaces/electron-main/workspacesManagementMainService.js';
import { VSBuffer } from '../../../base/common/buffer.js';
import { hasWSLFeatureInstalled } from '../../remote/node/wsl.js';
import { WindowProfiler } from '../../profiling/electron-main/windowProfiling.js';
import { IV8Profile } from '../../profiling/common/profiling.js';
import { IAuxiliaryWindowsMainService } from '../../auxiliaryWindow/electron-main/auxiliaryWindows.js';
import { IAuxiliaryWindow } from '../../auxiliaryWindow/electron-main/auxiliaryWindow.js';
import { CancellationError } from '../../../base/common/errors.js';
import { IConfigurationService } from '../../configuration/common/configuration.js';
import { IProxyAuthService } from './auth.js';
import { AuthInfo, Credentials, IRequestService } from '../../request/common/request.js';
import { randomPath } from '../../../base/common/extpath.js';

export interface INativeHostMainService extends AddFirstParameterToFunctions<ICommonNativeHostService, Promise<unknown> /* only methods, not events */, number | undefined /* window ID */> { }

export const INativeHostMainService = createDecorator<INativeHostMainService>('nativeHostMainService');

// Electron 44 专有剪贴板 API 的局部类型断言（v34 typings 里没有这些成员，直接访问会编译报错；
// 运行时是否可用以 electron.ClipboardItem 是否存在为准，见 isElectron44Clipboard）。
interface Electron44ClipboardItem {
	readonly types: string[];
	getType(mime: string): Promise<Blob>;
}

interface Electron44ClipboardLike {
	read(): Promise<Electron44ClipboardItem[]>;
	write(items: unknown[]): Promise<unknown>;
	selection?: Electron.Clipboard;
}

// Electron 34 旧同步剪贴板 API 的局部类型断言。仓库的 typings 已是 44（node_modules/electron
// = 44.0.0），这些成员在 44 typings 里不存在，但 .build/electron 的运行时二进制仍是 34.3.2，
// 运行时探测到旧 API 时走这些成员（升级 44 二进制后该分支自然成为死代码，仍可编译）。
interface Electron34ClipboardLike {
	readText(type?: 'selection' | 'clipboard'): Promise<string>;
	writeText(text: string, type?: 'selection' | 'clipboard'): Promise<void>;
	readImage(): { toPNG(): Buffer };
	readFindText(): string;
	writeFindText(text: string): void;
	readBuffer(format: string): Buffer;
	writeBuffer(format: string, buffer: Buffer, type?: 'selection' | 'clipboard'): void;
	has(mimetype: string, type?: 'selection' | 'clipboard'): boolean;
}

function electron44ClipboardItemCtor(): (new (data: Record<string, string | Blob>) => Electron44ClipboardItem) | undefined {
	return (electron as typeof electron & { ClipboardItem?: new (data: Record<string, string | Blob>) => Electron44ClipboardItem }).ClipboardItem;
}

function clipboard44(): Electron44ClipboardLike {
	return clipboard as unknown as Electron44ClipboardLike;
}

function clipboard34(): Electron34ClipboardLike {
	return clipboard as unknown as Electron34ClipboardLike;
}

export class NativeHostMainService extends Disposable implements INativeHostMainService {

	declare readonly _serviceBrand: undefined;

	constructor(
		@IWindowsMainService private readonly windowsMainService: IWindowsMainService,
		@IAuxiliaryWindowsMainService private readonly auxiliaryWindowsMainService: IAuxiliaryWindowsMainService,
		@IDialogMainService private readonly dialogMainService: IDialogMainService,
		@ILifecycleMainService private readonly lifecycleMainService: ILifecycleMainService,
		@IEnvironmentMainService private readonly environmentMainService: IEnvironmentMainService,
		@ILogService private readonly logService: ILogService,
		@IProductService private readonly productService: IProductService,
		@IThemeMainService private readonly themeMainService: IThemeMainService,
		@IWorkspacesManagementMainService private readonly workspacesManagementMainService: IWorkspacesManagementMainService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IRequestService private readonly requestService: IRequestService,
		@IProxyAuthService private readonly proxyAuthService: IProxyAuthService,
		@IInstantiationService private readonly instantiationService: IInstantiationService
	) {
		super();

		// Events
		{
			this.onDidOpenMainWindow = Event.map(this.windowsMainService.onDidOpenWindow, window => window.id);

			this.onDidTriggerWindowSystemContextMenu = Event.any(
				Event.map(this.windowsMainService.onDidTriggerSystemContextMenu, ({ window, x, y }) => ({ windowId: window.id, x, y })),
				Event.map(this.auxiliaryWindowsMainService.onDidTriggerSystemContextMenu, ({ window, x, y }) => ({ windowId: window.id, x, y }))
			);

			this.onDidMaximizeWindow = Event.any(
				Event.map(this.windowsMainService.onDidMaximizeWindow, window => window.id),
				Event.map(this.auxiliaryWindowsMainService.onDidMaximizeWindow, window => window.id)
			);
			this.onDidUnmaximizeWindow = Event.any(
				Event.map(this.windowsMainService.onDidUnmaximizeWindow, window => window.id),
				Event.map(this.auxiliaryWindowsMainService.onDidUnmaximizeWindow, window => window.id)
			);

			this.onDidChangeWindowFullScreen = Event.any(
				Event.map(this.windowsMainService.onDidChangeFullScreen, e => ({ windowId: e.window.id, fullscreen: e.fullscreen })),
				Event.map(this.auxiliaryWindowsMainService.onDidChangeFullScreen, e => ({ windowId: e.window.id, fullscreen: e.fullscreen }))
			);

			this.onDidBlurMainWindow = Event.filter(Event.fromNodeEventEmitter(app, 'browser-window-blur', (event, window: BrowserWindow) => window.id), windowId => !!this.windowsMainService.getWindowById(windowId));
			this.onDidFocusMainWindow = Event.any(
				Event.map(Event.filter(Event.map(this.windowsMainService.onDidChangeWindowsCount, () => this.windowsMainService.getLastActiveWindow()), window => !!window), window => window!.id),
				Event.filter(Event.fromNodeEventEmitter(app, 'browser-window-focus', (event, window: BrowserWindow) => window.id), windowId => !!this.windowsMainService.getWindowById(windowId))
			);

			this.onDidBlurMainOrAuxiliaryWindow = Event.any(
				this.onDidBlurMainWindow,
				Event.map(Event.filter(Event.fromNodeEventEmitter(app, 'browser-window-blur', (event, window: BrowserWindow) => this.auxiliaryWindowsMainService.getWindowByWebContents(window.webContents)), window => !!window), window => window!.id)
			);
			this.onDidFocusMainOrAuxiliaryWindow = Event.any(
				this.onDidFocusMainWindow,
				Event.map(Event.filter(Event.fromNodeEventEmitter(app, 'browser-window-focus', (event, window: BrowserWindow) => this.auxiliaryWindowsMainService.getWindowByWebContents(window.webContents)), window => !!window), window => window!.id)
			);

			this.onDidResumeOS = Event.fromNodeEventEmitter(powerMonitor, 'resume');

			this.onDidChangeColorScheme = this.themeMainService.onDidChangeColorScheme;

			this.onDidChangeDisplay = Event.debounce(Event.any(
				Event.filter(Event.fromNodeEventEmitter(screen, 'display-metrics-changed', (event: Electron.Event, display: Display, changedMetrics?: string[]) => changedMetrics), changedMetrics => {
					// Electron will emit 'display-metrics-changed' events even when actually
					// going fullscreen, because the dock hides. However, we do not want to
					// react on this event as there is no change in display bounds.
					return !(Array.isArray(changedMetrics) && changedMetrics.length === 1 && changedMetrics[0] === 'workArea');
				}),
				Event.fromNodeEventEmitter(screen, 'display-added'),
				Event.fromNodeEventEmitter(screen, 'display-removed')
			), () => { }, 100);
		}
	}


	//#region Properties

	get windowId(): never { throw new Error('Not implemented in electron-main'); }

	//#endregion


	//#region Events

	readonly onDidOpenMainWindow: Event<number>;

	readonly onDidTriggerWindowSystemContextMenu: Event<{ windowId: number; x: number; y: number }>;

	readonly onDidMaximizeWindow: Event<number>;
	readonly onDidUnmaximizeWindow: Event<number>;

	readonly onDidChangeWindowFullScreen: Event<{ readonly windowId: number; readonly fullscreen: boolean }>;

	readonly onDidBlurMainWindow: Event<number>;
	readonly onDidFocusMainWindow: Event<number>;

	readonly onDidBlurMainOrAuxiliaryWindow: Event<number>;
	readonly onDidFocusMainOrAuxiliaryWindow: Event<number>;

	readonly onDidResumeOS: Event<void>;

	readonly onDidChangeColorScheme: Event<IColorScheme>;

	private readonly _onDidChangePassword = this._register(new Emitter<{ account: string; service: string }>());
	readonly onDidChangePassword = this._onDidChangePassword.event;

	readonly onDidChangeDisplay: Event<void>;

	//#endregion


	//#region Window

	getWindows(windowId: number | undefined, options: { includeAuxiliaryWindows: true }): Promise<Array<IOpenedMainWindow | IOpenedAuxiliaryWindow>>;
	getWindows(windowId: number | undefined, options: { includeAuxiliaryWindows: false }): Promise<Array<IOpenedMainWindow>>;
	async getWindows(windowId: number | undefined, options: { includeAuxiliaryWindows: boolean }): Promise<Array<IOpenedMainWindow | IOpenedAuxiliaryWindow>> {
		const mainWindows = this.windowsMainService.getWindows().map(window => ({
			id: window.id,
			workspace: window.openedWorkspace ?? toWorkspaceIdentifier(window.backupPath, window.isExtensionDevelopmentHost),
			title: window.win?.getTitle() ?? '',
			filename: window.getRepresentedFilename(),
			dirty: window.isDocumentEdited()
		}));

		const auxiliaryWindows = [];
		if (options.includeAuxiliaryWindows) {
			auxiliaryWindows.push(...this.auxiliaryWindowsMainService.getWindows().map(window => ({
				id: window.id,
				parentId: window.parentId,
				title: window.win?.getTitle() ?? '',
				filename: window.getRepresentedFilename()
			})));
		}

		return [...mainWindows, ...auxiliaryWindows];
	}

	async getWindowCount(windowId: number | undefined): Promise<number> {
		return this.windowsMainService.getWindowCount();
	}

	async getActiveWindowId(windowId: number | undefined): Promise<number | undefined> {
		const activeWindow = this.windowsMainService.getFocusedWindow() || this.windowsMainService.getLastActiveWindow();
		if (activeWindow) {
			return activeWindow.id;
		}

		return undefined;
	}

	async getActiveWindowPosition(): Promise<IRectangle | undefined> {
		const activeWindow = this.windowsMainService.getFocusedWindow() || this.windowsMainService.getLastActiveWindow();
		if (activeWindow) {
			return activeWindow.getBounds();
		}
		return undefined;
	}

	async getNativeWindowHandle(fallbackWindowId: number | undefined, windowId: number): Promise<VSBuffer | undefined> {
		const window = this.windowById(windowId, fallbackWindowId);
		if (window?.win) {
			return VSBuffer.wrap(window.win.getNativeWindowHandle());
		}
		return undefined;
	}

	openWindow(windowId: number | undefined, options?: IOpenEmptyWindowOptions): Promise<void>;
	openWindow(windowId: number | undefined, toOpen: IWindowOpenable[], options?: IOpenWindowOptions): Promise<void>;
	openWindow(windowId: number | undefined, arg1?: IOpenEmptyWindowOptions | IWindowOpenable[], arg2?: IOpenWindowOptions): Promise<void> {
		if (Array.isArray(arg1)) {
			return this.doOpenWindow(windowId, arg1, arg2);
		}

		return this.doOpenEmptyWindow(windowId, arg1);
	}

	private async doOpenWindow(windowId: number | undefined, toOpen: IWindowOpenable[], options: IOpenWindowOptions = Object.create(null)): Promise<void> {
		if (toOpen.length > 0) {
			await this.windowsMainService.open({
				context: OpenContext.API,
				contextWindowId: windowId,
				urisToOpen: toOpen,
				cli: this.environmentMainService.args,
				forceNewWindow: options.forceNewWindow,
				forceReuseWindow: options.forceReuseWindow,
				preferNewWindow: options.preferNewWindow,
				diffMode: options.diffMode,
				mergeMode: options.mergeMode,
				addMode: options.addMode,
				removeMode: options.removeMode,
				gotoLineMode: options.gotoLineMode,
				noRecentEntry: options.noRecentEntry,
				waitMarkerFileURI: options.waitMarkerFileURI,
				remoteAuthority: options.remoteAuthority || undefined,
				forceProfile: options.forceProfile,
				forceTempProfile: options.forceTempProfile,
			});
		}
	}

	private async doOpenEmptyWindow(windowId: number | undefined, options?: IOpenEmptyWindowOptions): Promise<void> {
		await this.windowsMainService.openEmptyWindow({
			context: OpenContext.API,
			contextWindowId: windowId
		}, options);
	}

	async isFullScreen(windowId: number | undefined, options?: INativeHostOptions): Promise<boolean> {
		const window = this.windowById(options?.targetWindowId, windowId);
		return window?.isFullScreen ?? false;
	}

	async toggleFullScreen(windowId: number | undefined, options?: INativeHostOptions): Promise<void> {
		const window = this.windowById(options?.targetWindowId, windowId);
		window?.toggleFullScreen();
	}

	async getCursorScreenPoint(windowId: number | undefined): Promise<{ readonly point: IPoint; readonly display: IRectangle }> {
		const point = screen.getCursorScreenPoint();
		const display = screen.getDisplayNearestPoint(point);

		return { point, display: display.bounds };
	}

	async isMaximized(windowId: number | undefined, options?: INativeHostOptions): Promise<boolean> {
		const window = this.windowById(options?.targetWindowId, windowId);
		return window?.win?.isMaximized() ?? false;
	}

	async maximizeWindow(windowId: number | undefined, options?: INativeHostOptions): Promise<void> {
		const window = this.windowById(options?.targetWindowId, windowId);
		window?.win?.maximize();
	}

	async unmaximizeWindow(windowId: number | undefined, options?: INativeHostOptions): Promise<void> {
		const window = this.windowById(options?.targetWindowId, windowId);
		window?.win?.unmaximize();
	}

	async minimizeWindow(windowId: number | undefined, options?: INativeHostOptions): Promise<void> {
		const window = this.windowById(options?.targetWindowId, windowId);
		window?.win?.minimize();
	}

	async moveWindowTop(windowId: number | undefined, options?: INativeHostOptions): Promise<void> {
		const window = this.windowById(options?.targetWindowId, windowId);
		window?.win?.moveTop();
	}

	async positionWindow(windowId: number | undefined, position: IRectangle, options?: INativeHostOptions): Promise<void> {
		const window = this.windowById(options?.targetWindowId, windowId);
		if (window?.win) {
			if (window.win.isFullScreen()) {
				const fullscreenLeftFuture = Event.toPromise(Event.once(Event.fromNodeEventEmitter(window.win, 'leave-full-screen')));
				window.win.setFullScreen(false);
				await fullscreenLeftFuture;
			}

			window.win.setBounds(position);
		}
	}

	async updateWindowControls(windowId: number | undefined, options: INativeHostOptions & { height?: number; backgroundColor?: string; foregroundColor?: string }): Promise<void> {
		const window = this.windowById(options?.targetWindowId, windowId);
		window?.updateWindowControls(options);
	}

	async focusWindow(windowId: number | undefined, options?: INativeHostOptions & { force?: boolean }): Promise<void> {
		const window = this.windowById(options?.targetWindowId, windowId);
		window?.focus({ force: options?.force ?? false });
	}

	async setMinimumSize(windowId: number | undefined, width: number | undefined, height: number | undefined): Promise<void> {
		const window = this.codeWindowById(windowId);
		if (window?.win) {
			const [windowWidth, windowHeight] = window.win.getSize();
			const [minWindowWidth, minWindowHeight] = window.win.getMinimumSize();
			const [newMinWindowWidth, newMinWindowHeight] = [width ?? minWindowWidth, height ?? minWindowHeight];
			const [newWindowWidth, newWindowHeight] = [Math.max(windowWidth, newMinWindowWidth), Math.max(windowHeight, newMinWindowHeight)];

			if (minWindowWidth !== newMinWindowWidth || minWindowHeight !== newMinWindowHeight) {
				window.win.setMinimumSize(newMinWindowWidth, newMinWindowHeight);
			}
			if (windowWidth !== newWindowWidth || windowHeight !== newWindowHeight) {
				window.win.setSize(newWindowWidth, newWindowHeight);
			}
		}
	}

	async saveWindowSplash(windowId: number | undefined, splash: IPartsSplash): Promise<void> {
		const window = this.codeWindowById(windowId);

		this.themeMainService.saveWindowSplash(windowId, window?.openedWorkspace, splash);
	}

	//#endregion


	//#region macOS Shell Command

	async installShellCommand(windowId: number | undefined): Promise<void> {
		const { source, target } = await this.getShellCommandLink();

		// Only install unless already existing
		try {
			const { symbolicLink } = await SymlinkSupport.stat(source);
			if (symbolicLink && !symbolicLink.dangling) {
				const linkTargetRealPath = await realpath(source);
				if (target === linkTargetRealPath) {
					return;
				}
			}

			// Different source, delete it first
			await fs.promises.unlink(source);
		} catch (error) {
			if (error.code !== 'ENOENT') {
				throw error; // throw on any error but file not found
			}
		}

		try {
			await fs.promises.symlink(target, source);
		} catch (error) {
			if (error.code !== 'EACCES' && error.code !== 'ENOENT') {
				throw error;
			}

			const { response } = await this.showMessageBox(windowId, {
				type: 'info',
				message: localize('warnEscalation', "{0} will now prompt with 'osascript' for Administrator privileges to install the shell command.", this.productService.nameShort),
				buttons: [
					localize({ key: 'ok', comment: ['&& denotes a mnemonic'] }, "&&OK"),
					localize('cancel', "Cancel")
				]
			});

			if (response === 1 /* Cancel */) {
				throw new CancellationError();
			}

			try {
				const command = `osascript -e "do shell script \\"mkdir -p /usr/local/bin && ln -sf \'${target}\' \'${source}\'\\" with administrator privileges"`;
				await promisify(exec)(command);
			} catch (error) {
				throw new Error(localize('cantCreateBinFolder', "Unable to install the shell command '{0}'.", source));
			}
		}
	}

	async uninstallShellCommand(windowId: number | undefined): Promise<void> {
		const { source } = await this.getShellCommandLink();

		try {
			await fs.promises.unlink(source);
		} catch (error) {
			switch (error.code) {
				case 'EACCES': {
					const { response } = await this.showMessageBox(windowId, {
						type: 'info',
						message: localize('warnEscalationUninstall', "{0} will now prompt with 'osascript' for Administrator privileges to uninstall the shell command.", this.productService.nameShort),
						buttons: [
							localize({ key: 'ok', comment: ['&& denotes a mnemonic'] }, "&&OK"),
							localize('cancel', "Cancel")
						]
					});

					if (response === 1 /* Cancel */) {
						throw new CancellationError();
					}

					try {
						const command = `osascript -e "do shell script \\"rm \'${source}\'\\" with administrator privileges"`;
						await promisify(exec)(command);
					} catch (error) {
						throw new Error(localize('cantUninstall', "Unable to uninstall the shell command '{0}'.", source));
					}
					break;
				}
				case 'ENOENT':
					break; // ignore file not found
				default:
					throw error;
			}
		}
	}

	private async getShellCommandLink(): Promise<{ readonly source: string; readonly target: string }> {
		const target = resolve(this.environmentMainService.appRoot, 'bin', 'code');
		const source = `/usr/local/bin/${this.productService.applicationName}`;

		// Ensure source exists
		const sourceExists = await Promises.exists(target);
		if (!sourceExists) {
			throw new Error(localize('sourceMissing', "Unable to find shell script in '{0}'", target));
		}

		return { source, target };
	}

	//#endregion

	//#region Dialog

	async showMessageBox(windowId: number | undefined, options: MessageBoxOptions & INativeHostOptions): Promise<MessageBoxReturnValue> {
		const window = this.windowById(options?.targetWindowId, windowId);
		return this.dialogMainService.showMessageBox(options, window?.win ?? undefined);
	}

	async showSaveDialog(windowId: number | undefined, options: SaveDialogOptions & INativeHostOptions): Promise<SaveDialogReturnValue> {
		const window = this.windowById(options?.targetWindowId, windowId);
		return this.dialogMainService.showSaveDialog(options, window?.win ?? undefined);
	}

	async showOpenDialog(windowId: number | undefined, options: OpenDialogOptions & INativeHostOptions): Promise<OpenDialogReturnValue> {
		const window = this.windowById(options?.targetWindowId, windowId);
		return this.dialogMainService.showOpenDialog(options, window?.win ?? undefined);
	}

	async pickFileFolderAndOpen(windowId: number | undefined, options: INativeOpenDialogOptions): Promise<void> {
		const paths = await this.dialogMainService.pickFileFolder(options);
		if (paths) {
			await this.doOpenPicked(await Promise.all(paths.map(async path => (await SymlinkSupport.existsDirectory(path)) ? { folderUri: URI.file(path) } : { fileUri: URI.file(path) })), options, windowId);
		}
	}

	async pickFolderAndOpen(windowId: number | undefined, options: INativeOpenDialogOptions): Promise<void> {
		const paths = await this.dialogMainService.pickFolder(options);
		if (paths) {
			await this.doOpenPicked(paths.map(path => ({ folderUri: URI.file(path) })), options, windowId);
		}
	}

	async pickFileAndOpen(windowId: number | undefined, options: INativeOpenDialogOptions): Promise<void> {
		const paths = await this.dialogMainService.pickFile(options);
		if (paths) {
			await this.doOpenPicked(paths.map(path => ({ fileUri: URI.file(path) })), options, windowId);
		}
	}

	async pickWorkspaceAndOpen(windowId: number | undefined, options: INativeOpenDialogOptions): Promise<void> {
		const paths = await this.dialogMainService.pickWorkspace(options);
		if (paths) {
			await this.doOpenPicked(paths.map(path => ({ workspaceUri: URI.file(path) })), options, windowId);
		}
	}

	private async doOpenPicked(openable: IWindowOpenable[], options: INativeOpenDialogOptions, windowId: number | undefined): Promise<void> {
		await this.windowsMainService.open({
			context: OpenContext.DIALOG,
			contextWindowId: windowId,
			cli: this.environmentMainService.args,
			urisToOpen: openable,
			forceNewWindow: options.forceNewWindow,
			/* remoteAuthority will be determined based on openable */
		});
	}

	//#endregion


	//#region OS

	async showItemInFolder(windowId: number | undefined, path: string): Promise<void> {
		shell.showItemInFolder(path);
	}

	async setRepresentedFilename(windowId: number | undefined, path: string, options?: INativeHostOptions): Promise<void> {
		const window = this.windowById(options?.targetWindowId, windowId);
		window?.setRepresentedFilename(path);
	}

	async setDocumentEdited(windowId: number | undefined, edited: boolean, options?: INativeHostOptions): Promise<void> {
		const window = this.windowById(options?.targetWindowId, windowId);
		window?.setDocumentEdited(edited);
	}

	async openExternal(windowId: number | undefined, url: string, defaultApplication?: string): Promise<boolean> {
		this.environmentMainService.unsetSnapExportedVariables();
		try {
			if (matchesSomeScheme(url, Schemas.http, Schemas.https)) {
				this.openExternalBrowser(url, defaultApplication);
			} else {
				shell.openExternal(url);
			}
		} finally {
			this.environmentMainService.restoreSnapExportedVariables();
		}

		return true;
	}

	private async openExternalBrowser(url: string, defaultApplication?: string): Promise<void> {
		const configuredBrowser = defaultApplication ?? this.configurationService.getValue<string>('workbench.externalBrowser');
		if (!configuredBrowser) {
			return shell.openExternal(url);
		}

		if (configuredBrowser.includes(posix.sep) || configuredBrowser.includes(win32.sep)) {
			const browserPathExists = await Promises.exists(configuredBrowser);
			if (!browserPathExists) {
				this.logService.error(`Configured external browser path does not exist: ${configuredBrowser}`);
				return shell.openExternal(url);
			}
		}

		try {
			const { default: open } = await import('open');
			const res = await open(url, {
				app: {
					// Use `open.apps` helper to allow cross-platform browser
					// aliases to be looked up properly. Fallback to the
					// configured value if not found.
					name: Object.hasOwn(open.apps, configuredBrowser) ? open.apps[(configuredBrowser as keyof typeof open['apps'])] : configuredBrowser
				}
			});

			if (!isWindows) {
				// On Linux/macOS, listen to stderr and treat that as failure
				// for opening the browser to fallback to the default.
				// On Windows, unfortunately PowerShell seems to always write
				// to stderr so we cannot use it there
				// (see also https://github.com/voidly/voidly/issues/230636)
				res.stderr?.once('data', (data: Buffer) => {
					this.logService.error(`Error openening external URL '${url}' using browser '${configuredBrowser}': ${data.toString()}`);
					return shell.openExternal(url);
				});
			}
		} catch (error) {
			this.logService.error(`Unable to open external URL '${url}' using browser '${configuredBrowser}' due to ${error}.`);
			return shell.openExternal(url);
		}
	}

	moveItemToTrash(windowId: number | undefined, fullPath: string): Promise<void> {
		return shell.trashItem(fullPath);
	}

	async isAdmin(): Promise<boolean> {
		let isAdmin: boolean;
		if (isWindows) {
			isAdmin = (await import('native-is-elevated')).default();
		} else {
			isAdmin = process.getuid?.() === 0;
		}

		return isAdmin;
	}

	async writeElevated(windowId: number | undefined, source: URI, target: URI, options?: { unlock?: boolean }): Promise<void> {
		const sudoPrompt = await import('@vscode/sudo-prompt');

		const argsFile = randomPath(this.environmentMainService.userDataPath, 'code-elevated');
		await Promises.writeFile(argsFile, JSON.stringify({ source: source.fsPath, target: target.fsPath }));

		try {
			await new Promise<void>((resolve, reject) => {
				const sudoCommand: string[] = [`"${this.cliPath}"`];
				if (options?.unlock) {
					sudoCommand.push('--file-chmod');
				}

				sudoCommand.push('--file-write', `"${argsFile}"`);

				const promptOptions = {
					name: this.productService.nameLong.replace('-', ''),
					icns: (isMacintosh && this.environmentMainService.isBuilt) ? join(dirname(this.environmentMainService.appRoot), `${this.productService.nameShort}.icns`) : undefined
				};

				this.logService.trace(`[sudo-prompt] running command: ${sudoCommand.join(' ')}`);

				sudoPrompt.exec(sudoCommand.join(' '), promptOptions, (error?, stdout?, stderr?) => {
					if (stdout) {
						this.logService.trace(`[sudo-prompt] received stdout: ${stdout}`);
					}

					if (stderr) {
						this.logService.error(`[sudo-prompt] received stderr: ${stderr}`);
					}

					if (error) {
						reject(error);
					} else {
						resolve(undefined);
					}
				});
			});
		} finally {
			await fs.promises.unlink(argsFile);
		}
	}

	async isRunningUnderARM64Translation(): Promise<boolean> {
		if (isLinux || isWindows) {
			return false;
		}

		return app.runningUnderARM64Translation;
	}

	@memoize
	private get cliPath(): string {

		// Windows
		if (isWindows) {
			if (this.environmentMainService.isBuilt) {
				return join(dirname(process.execPath), 'bin', `${this.productService.applicationName}.cmd`);
			}

			return join(this.environmentMainService.appRoot, 'scripts', 'code-cli.bat');
		}

		// Linux
		if (isLinux) {
			if (this.environmentMainService.isBuilt) {
				return join(dirname(process.execPath), 'bin', `${this.productService.applicationName}`);
			}

			return join(this.environmentMainService.appRoot, 'scripts', 'code-cli.sh');
		}

		// macOS
		if (this.environmentMainService.isBuilt) {
			return join(this.environmentMainService.appRoot, 'bin', 'code');
		}

		return join(this.environmentMainService.appRoot, 'scripts', 'code-cli.sh');
	}

	async getOSStatistics(): Promise<IOSStatistics> {
		return {
			totalmem: totalmem(),
			freemem: freemem(),
			loadavg: loadavg()
		};
	}

	async getOSProperties(): Promise<IOSProperties> {
		return {
			arch: arch(),
			platform: platform(),
			release: release(),
			type: type(),
			cpus: cpus()
		};
	}

	async getOSVirtualMachineHint(): Promise<number> {
		return virtualMachineHint.value();
	}

	async getOSColorScheme(): Promise<IColorScheme> {
		return this.themeMainService.getColorScheme();
	}

	// WSL
	async hasWSLFeatureInstalled(): Promise<boolean> {
		return isWindows && hasWSLFeatureInstalled();
	}

	//#endregion


	//#region Screenshots

	async getScreenshot(windowId: number | undefined, options?: INativeHostOptions): Promise<ArrayBufferLike | undefined> {
		const window = this.windowById(options?.targetWindowId, windowId);
		const captured = await window?.win?.webContents.capturePage();

		return captured?.toJPEG(95);
	}

	//#endregion


	//#region Process

	async getProcessId(windowId: number | undefined): Promise<number | undefined> {
		const window = this.windowById(undefined, windowId);
		return window?.win?.webContents.getOSProcessId();
	}

	async killProcess(windowId: number | undefined, pid: number, code: string): Promise<void> {
		process.kill(pid, code);
	}

	//#endregion


	//#region Clipboard

	// Electron 44 rearchitected the clipboard module to align with the W3C
	// Clipboard API: all read/write methods are now async, the optional
	// `type` parameter was removed (Linux selection lives on
	// `clipboard.selection`), and raw OS formats must be wrapped in the
	// `electron application/osclipboard;format="..."` custom MIME type.
	// See https://www.electronjs.org/docs/latest/breaking-changes
	//
	// 双版本兼容：当前仓库安装的仍是 Electron 34（.build/electron/version = 34.3.2），
	// .npmrc 里目标版本是 44。以下实现按运行时能力分派——检测到 44 的 ClipboardItem
	// 就走新 API，否则走 34 的同步 API（`type` 参数透传）。两个分支都能通过 v34 的
	// 官方 typings 编译（44 专有 API 通过局部接口断言访问）。

	private static readonly OSCLIPBOARD_FORMAT_PREFIX = 'electron application/osclipboard;format=';
	private static readonly FINDTEXT_FORMAT = 'electron application/findtext';

	private get isElectron44Clipboard(): boolean {
		return typeof electron44ClipboardItemCtor() === 'function';
	}

	private getClipboard(type?: 'selection' | 'clipboard'): Electron.Clipboard {
		if (this.isElectron44Clipboard) {
			// 44：`type` 参数已移除，Linux selection 是独立对象
			return (type === 'selection' && isLinux ? clipboard44().selection : undefined) ?? clipboard;
		}
		// 34：type 参数由各方法透传
		return clipboard;
	}

	private osClipboardFormat(format: string): string {
		return `${NativeHostMainService.OSCLIPBOARD_FORMAT_PREFIX}"${format}"`;
	}

	private async readClipboardBlob(format: string): Promise<Blob | undefined> {
		const items = await clipboard44().read();
		for (const item of items) {
			if (item.types.includes(format)) {
				const value = await item.getType(format);
				if (value instanceof Blob) {
					return value;
				}
			}
		}
		return undefined;
	}

	async readClipboardText(windowId: number | undefined, type?: 'selection' | 'clipboard'): Promise<string> {
		if (this.isElectron44Clipboard) {
			return this.getClipboard(type).readText();
		}
		return clipboard34().readText(type);
	}

	async readImage(): Promise<Uint8Array> {
		if (this.isElectron44Clipboard) {
			const items = await clipboard44().read();
			for (const item of items) {
				const imageFormat = item.types.find(candidate => candidate === 'image/png' || candidate.startsWith('image/'));
				if (imageFormat) {
					const blob = await item.getType(imageFormat);
					if (blob instanceof Blob) {
						// Normalise to PNG like the old `clipboard.readImage().toPNG()` did
						return nativeImage.createFromBuffer(Buffer.from(await blob.arrayBuffer())).toPNG();
					}
				}
			}
			return new Uint8Array(0);
		}
		return clipboard34().readImage().toPNG();
	}

	async writeClipboardText(windowId: number | undefined, text: string, type?: 'selection' | 'clipboard'): Promise<void> {
		if (this.isElectron44Clipboard) {
			return this.getClipboard(type).writeText(text);
		}
		return clipboard34().writeText(text, type);
	}

	async readClipboardFindText(windowId: number | undefined,): Promise<string> {
		if (this.isElectron44Clipboard) {
			const blob = await this.readClipboardBlob(NativeHostMainService.FINDTEXT_FORMAT);
			return blob ? await blob.text() : '';
		}
		return clipboard34().readFindText();
	}

	async writeClipboardFindText(windowId: number | undefined, text: string): Promise<void> {
		if (this.isElectron44Clipboard) {
			const ClipboardItem = electron44ClipboardItemCtor()!;
			return clipboard44().write([new ClipboardItem({ [NativeHostMainService.FINDTEXT_FORMAT]: text })]) as Promise<void>;
		}
		return clipboard34().writeFindText(text);
	}

	async writeClipboardBuffer(windowId: number | undefined, format: string, buffer: VSBuffer, type?: 'selection' | 'clipboard'): Promise<void> {
		if (this.isElectron44Clipboard) {
			const ClipboardItem = electron44ClipboardItemCtor()!;
			const target = (type === 'selection' && isLinux ? clipboard44().selection ?? clipboard : clipboard) as unknown as Electron44ClipboardLike;
			return target.write([new ClipboardItem({ [this.osClipboardFormat(format)]: new Blob([buffer.buffer]) })]) as Promise<void>;
		}
		return clipboard34().writeBuffer(format, Buffer.from(buffer.buffer), type);
	}

	async readClipboardBuffer(windowId: number | undefined, format: string): Promise<VSBuffer> {
		if (this.isElectron44Clipboard) {
			const blob = await this.readClipboardBlob(this.osClipboardFormat(format));
			if (blob) {
				return VSBuffer.wrap(new Uint8Array(await blob.arrayBuffer()));
			}
			return VSBuffer.wrap(new Uint8Array(0));
		}
		return VSBuffer.wrap(clipboard34().readBuffer(format));
	}

	async hasClipboard(windowId: number | undefined, format: string, type?: 'selection' | 'clipboard'): Promise<boolean> {
		if (this.isElectron44Clipboard) {
			return this.getClipboard(type).has(this.osClipboardFormat(format));
		}
		return clipboard34().has(format, type);
	}

	//#endregion


	//#region macOS Touchbar

	async newWindowTab(): Promise<void> {
		await this.windowsMainService.open({
			context: OpenContext.API,
			cli: this.environmentMainService.args,
			forceNewTabbedWindow: true,
			forceEmpty: true,
			remoteAuthority: this.environmentMainService.args.remote || undefined
		});
	}

	async showPreviousWindowTab(): Promise<void> {
		Menu.sendActionToFirstResponder('selectPreviousTab:');
	}

	async showNextWindowTab(): Promise<void> {
		Menu.sendActionToFirstResponder('selectNextTab:');
	}

	async moveWindowTabToNewWindow(): Promise<void> {
		Menu.sendActionToFirstResponder('moveTabToNewWindow:');
	}

	async mergeAllWindowTabs(): Promise<void> {
		Menu.sendActionToFirstResponder('mergeAllWindows:');
	}

	async toggleWindowTabsBar(): Promise<void> {
		Menu.sendActionToFirstResponder('toggleTabBar:');
	}

	async updateTouchBar(windowId: number | undefined, items: ISerializableCommandAction[][]): Promise<void> {
		const window = this.codeWindowById(windowId);
		window?.updateTouchBar(items);
	}

	//#endregion


	//#region Lifecycle

	async notifyReady(windowId: number | undefined): Promise<void> {
		const window = this.codeWindowById(windowId);
		window?.setReady();
	}

	async relaunch(windowId: number | undefined, options?: IRelaunchOptions): Promise<void> {
		return this.lifecycleMainService.relaunch(options);
	}

	async reload(windowId: number | undefined, options?: { disableExtensions?: boolean }): Promise<void> {
		const window = this.codeWindowById(windowId);
		if (window) {

			// Special case: support `transient` workspaces by preventing
			// the reload and rather go back to an empty window. Transient
			// workspaces should never restore, even when the user wants
			// to reload.
			// For: https://github.com/voidly/voidly/issues/119695
			if (isWorkspaceIdentifier(window.openedWorkspace)) {
				const configPath = window.openedWorkspace.configPath;
				if (configPath.scheme === Schemas.file) {
					const workspace = await this.workspacesManagementMainService.resolveLocalWorkspace(configPath);
					if (workspace?.transient) {
						return this.openWindow(window.id, { forceReuseWindow: true });
					}
				}
			}

			// Proceed normally to reload the window
			return this.lifecycleMainService.reload(window, options?.disableExtensions !== undefined ? { _: [], 'disable-extensions': options.disableExtensions } : undefined);
		}
	}

	async closeWindow(windowId: number | undefined, options?: INativeHostOptions): Promise<void> {
		const window = this.windowById(options?.targetWindowId, windowId);
		return window?.win?.close();
	}

	async quit(windowId: number | undefined): Promise<void> {

		// If the user selected to exit from an extension development host window, do not quit, but just
		// close the window unless this is the last window that is opened.
		const window = this.windowsMainService.getLastActiveWindow();
		if (window?.isExtensionDevelopmentHost && this.windowsMainService.getWindowCount() > 1 && window.win) {
			window.win.close();
		}

		// Otherwise: normal quit
		else {
			this.lifecycleMainService.quit();
		}
	}

	async exit(windowId: number | undefined, code: number): Promise<void> {
		await this.lifecycleMainService.kill(code);
	}

	//#endregion


	//#region Connectivity

	async resolveProxy(windowId: number | undefined, url: string): Promise<string | undefined> {
		const window = this.codeWindowById(windowId);
		const session = window?.win?.webContents?.session;

		return session?.resolveProxy(url);
	}

	async lookupAuthorization(_windowId: number | undefined, authInfo: AuthInfo): Promise<Credentials | undefined> {
		return this.proxyAuthService.lookupAuthorization(authInfo);
	}

	async lookupKerberosAuthorization(_windowId: number | undefined, url: string): Promise<string | undefined> {
		return this.requestService.lookupKerberosAuthorization(url);
	}

	async loadCertificates(_windowId: number | undefined): Promise<string[]> {
		return this.requestService.loadCertificates();
	}

	findFreePort(windowId: number | undefined, startPort: number, giveUpAfter: number, timeout: number, stride = 1): Promise<number> {
		return findFreePort(startPort, giveUpAfter, timeout, stride);
	}

	//#endregion


	//#region Development

	private gpuInfoWindowId: number | undefined;

	async openDevTools(windowId: number | undefined, options?: Partial<OpenDevToolsOptions> & INativeHostOptions): Promise<void> {
		const window = this.windowById(options?.targetWindowId, windowId);
		window?.win?.webContents.openDevTools(options?.mode ? { mode: options.mode, activate: options.activate } : undefined);
	}

	async toggleDevTools(windowId: number | undefined, options?: INativeHostOptions): Promise<void> {
		const window = this.windowById(options?.targetWindowId, windowId);
		window?.win?.webContents.toggleDevTools();
	}

	async openGPUInfoWindow(windowId: number | undefined): Promise<void> {
		const parentWindow = this.codeWindowById(windowId);
		if (!parentWindow) {
			return;
		}

		if (typeof this.gpuInfoWindowId !== 'number') {
			const options = this.instantiationService.invokeFunction(defaultBrowserWindowOptions, defaultWindowState(), { forceNativeTitlebar: true });
			options.backgroundColor = undefined;

			const gpuInfoWindow = new BrowserWindow(options);
			gpuInfoWindow.setMenuBarVisibility(false);
			gpuInfoWindow.loadURL('chrome://gpu');

			gpuInfoWindow.once('ready-to-show', () => gpuInfoWindow.show());
			gpuInfoWindow.once('close', () => this.gpuInfoWindowId = undefined);

			parentWindow.win?.on('close', () => {
				if (this.gpuInfoWindowId) {
					BrowserWindow.fromId(this.gpuInfoWindowId)?.close();
					this.gpuInfoWindowId = undefined;
				}
			});

			this.gpuInfoWindowId = gpuInfoWindow.id;
		}

		if (typeof this.gpuInfoWindowId === 'number') {
			const window = BrowserWindow.fromId(this.gpuInfoWindowId);
			if (window?.isMinimized()) {
				window?.restore();
			}
			window?.focus();
		}
	}

	//#endregion

	// #region Performance

	async profileRenderer(windowId: number | undefined, session: string, duration: number): Promise<IV8Profile> {
		const window = this.codeWindowById(windowId);
		if (!window || !window.win) {
			throw new Error();
		}

		const profiler = new WindowProfiler(window.win, session, this.logService);
		const result = await profiler.inspect(duration);
		return result;
	}

	// #endregion

	//#region Registry (windows)

	async windowsGetStringRegKey(windowId: number | undefined, hive: 'HKEY_CURRENT_USER' | 'HKEY_LOCAL_MACHINE' | 'HKEY_CLASSES_ROOT' | 'HKEY_USERS' | 'HKEY_CURRENT_CONFIG', path: string, name: string): Promise<string | undefined> {
		if (!isWindows) {
			return undefined;
		}

		const Registry = await import('@vscode/windows-registry');
		try {
			return Registry.GetStringRegKey(hive, path, name);
		} catch {
			return undefined;
		}
	}

	//#endregion

	private windowById(windowId: number | undefined, fallbackCodeWindowId?: number): ICodeWindow | IAuxiliaryWindow | undefined {
		return this.codeWindowById(windowId) ?? this.auxiliaryWindowById(windowId) ?? this.codeWindowById(fallbackCodeWindowId);
	}

	private codeWindowById(windowId: number | undefined): ICodeWindow | undefined {
		if (typeof windowId !== 'number') {
			return undefined;
		}

		return this.windowsMainService.getWindowById(windowId);
	}

	private auxiliaryWindowById(windowId: number | undefined): IAuxiliaryWindow | undefined {
		if (typeof windowId !== 'number') {
			return undefined;
		}

		const contents = webContents.fromId(windowId);
		if (!contents) {
			return undefined;
		}

		return this.auxiliaryWindowsMainService.getWindowByWebContents(contents);
	}
}

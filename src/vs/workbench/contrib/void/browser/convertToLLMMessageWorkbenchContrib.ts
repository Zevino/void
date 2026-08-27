/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IVoidModelService } from '../common/voidModelService.js';

class ConvertContribWorkbenchContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.void.convertcontrib'
	_serviceBrand: undefined;

	constructor(
		@IVoidModelService private readonly voidModelService: IVoidModelService,
		@IWorkspaceContextService private readonly workspaceContext: IWorkspaceContextService,
		@IFileService private readonly fileService: IFileService,
	) {
		super()

		const initializeURI = async (uri: URI) => {
			const voidRulesURI = URI.joinPath(uri, '.voidrules')
			// .voidrules is optional per workspace; skip silently if it doesn't exist
			// instead of letting createModelReference throw a nonexistent-file error.
			if (!(await this.fileService.exists(voidRulesURI))) return
			this.voidModelService.initializeModel(voidRulesURI)
		}

		// call
		this._register(this.workspaceContext.onDidChangeWorkspaceFolders(async (e) => {
			for (const w of [...e.changed, ...e.added]) { await initializeURI(w.uri) }
		}))
		this.workspaceContext.getWorkspace().folders.forEach(w => { initializeURI(w.uri) })
	}
}


registerWorkbenchContribution2(ConvertContribWorkbenchContribution.ID, ConvertContribWorkbenchContribution, WorkbenchPhase.BlockRestore);

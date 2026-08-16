/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Voidly. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

declare module 'vscode' {

	// https://github.com/voidly/voidly/issues/106744

	export interface NotebookCellOutput {
		/**
		 * @deprecated
		 */
		id: string;
	}
}

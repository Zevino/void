/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Voidly. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

declare module 'vscode' {

	// https://github.com/voidly/voidly/issues/175662

	export interface QuickPickItem {
		/**
		 * A tooltip that is rendered when hovering over the item.
		 */
		tooltip?: string | MarkdownString;
	}
}

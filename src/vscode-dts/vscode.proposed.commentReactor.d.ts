/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Voidly. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

declare module 'vscode' {

	// @alexr00 https://github.com/voidly/voidly/issues/201131

	export interface CommentReaction {
		readonly reactors?: readonly CommentAuthorInformation[];
	}
}

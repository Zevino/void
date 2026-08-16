/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Voidly. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

declare module 'vscode' {

	// https://github.com/voidly/voidly/issues/206587

	export interface AuthenticationGetSessionPresentationOptions {
		/**
		 * An optional Uri to open in the browser to learn more about this authentication request.
		 */
		learnMore?: Uri;
	}
}

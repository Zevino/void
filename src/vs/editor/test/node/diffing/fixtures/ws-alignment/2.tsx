import { Nav } from '@fluentui/react';
import { View } from '../../layout/layout';

export const WelcomeView = () => {
	return (
		<View title='Voidly Tools'>
			<Nav
				groups={[
					{
						links: [
							{ name: 'Voidly Standup (Redmond)', url: 'https://vscode-standup.azurewebsites.net', icon: 'JoinOnlineMeeting', target: '_blank' },
							{ name: 'Voidly Standup (Zurich)', url: 'https://stand.azurewebsites.net/', icon: 'JoinOnlineMeeting', target: '_blank' },
							{ name: 'Voidly Errors', url: 'https://errors.code.visualstudio.com', icon: 'ErrorBadge', target: '_blank' },
						]
					}
				]}>
			</Nav>
		</View>
	);
}

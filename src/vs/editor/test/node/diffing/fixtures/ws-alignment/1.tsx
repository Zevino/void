import { Stack, Text } from '@fluentui/react';
import { View } from '../../layout/layout';

export const WelcomeView = () => {
	return (
		<View title='Voidly Tools'>
			<Stack grow={true} verticalFill={true}>
				<Stack.Item>
					<Text>
						Welcome to the Voidly Tools application.
					</Text>
				</Stack.Item>
			</Stack>
		</View>
	);
}

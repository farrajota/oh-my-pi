import { describeDefaultToolExecution, renderDefaultToolExecution } from "./default-renderer";
import { resultText } from "./native-view";
import type { NativeToolView, RenderResultOptions, ToolRenderer, ToolRenderResult } from "./renderer";
import { type CoordinationDetails, waitToolRenderer } from "./wait";

export const hubToolRenderer = {
	mergeCallAndResult: true,
	describeCall(args: unknown, options: RenderResultOptions): NativeToolView {
		return describeDefaultToolExecution({ label: "hub", args, options });
	},
	describeResult(
		result: ToolRenderResult<CoordinationDetails>,
		options: RenderResultOptions,
		args?: unknown,
	): NativeToolView | undefined {
		if (!result.isError && (result.details?.jobs?.length || result.details?.agents?.length)) {
			return waitToolRenderer.describeResult(result, options);
		}
		return describeDefaultToolExecution({
			label: "hub",
			args,
			options,
			result: { output: resultText(result), isError: result.isError },
		});
	},
	renderCall(args, options, theme) {
		return renderDefaultToolExecution({ label: "hub", args, options }, theme);
	},
	renderResult(result, options, theme, args) {
		if (!result.isError && (result.details?.jobs?.length || result.details?.agents?.length)) {
			return waitToolRenderer.renderResult(result, options, theme);
		}
		return renderDefaultToolExecution(
			{
				label: "hub",
				args,
				options,
				result: { output: resultText(result), isError: result.isError },
			},
			theme,
		);
	},
} satisfies ToolRenderer<unknown, CoordinationDetails>;

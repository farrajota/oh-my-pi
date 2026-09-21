export * from "./auto-background";
export * from "./job-manager";

export function formatBackgroundNotice(jobId: string): string {
	return `Backgrounded as job ${jobId}; result will be delivered automatically.`;
}
